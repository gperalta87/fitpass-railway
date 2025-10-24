// server.js — Fitpass capacity updater API (Express + Puppeteer)

import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- Basic health ----------
app.get("/", (_req, res) => res.send("✅ Fitpass automation online"));

// ---------- Utilities ----------
const TIMEOUT = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normTimeTokens = (txt) =>
  String(txt || "")
    .toLowerCase()
    .replace(/a\s*\.?\s*m\.?/gi, "am")
    .replace(/p\s*\.?\s*m\.?/gi, "pm");

function toMinutes(t) {
  const m = String(t).match(/^\s*(\d{1,2})[:\.](\d{2})\s*(am|pm|a\.?m\.?|p\.?m\.?)?\s*$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const apRaw = m[3]?.toLowerCase();
  if (apRaw) {
    const isPM = /p/.test(apRaw.replace(/\s|\./g, ""));
    if (h === 12 && !isPM) h = 0;
    if (h !== 12 && isPM) h += 12;
  }
  return h * 60 + min;
}

function extractStartTimeMinutes(txt) {
  const norm = normTimeTokens(txt);
  const m = norm.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  const hh = m[1],
    mm = m[2],
    ap = m[3] || "";
  return toMinutes(`${hh}:${mm}${ap ? " " + ap : ""}`);
}

// ---------- Robust calendar navigation (no nth-of-type) ----------
async function gotoCalendar(page, { DEBUG = false } = {}) {
  const dbg = (...a) => DEBUG && console.log("[DEBUG]", ...a);

  // 1) Click links that look like calendar
  const linkCandidates = [
    'a[href*="/calendar"]',
    '#sidebar a[href*="calendar"]',
    'nav a[href*="calendar"]',
    'a[href*="/schedules"]',
    'a[href*="agenda"]',
    'a[href*="horario"]'
  ];
  for (const sel of linkCandidates) {
    const el = await page.$(sel);
    if (el) {
      dbg("Clicking", sel);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
        el.click()
      ]);
      const onCal = await page.$(".fc, .fc-view, .fc-timegrid, .fc-daygrid");
      if (onCal) return true;
    }
  }

  // 2) Search by visible text
  const clickedByText = await page.evaluate(() => {
    const kws = ["calendar", "calendario", "agenda", "horario", "schedule"];
    const els = Array.from(
      document.querySelectorAll('a, button, [role="button"], [role="menuitem"] a, nav a')
    );
    for (const a of els) {
      const t = (a.innerText || a.textContent || "").toLowerCase().trim();
      if (kws.some((k) => t.includes(k))) {
        a.scrollIntoView({ block: "center", behavior: "instant" });
        a.click();
        return true;
      }
    }
    return false;
  });
  if (clickedByText) {
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
    const onCal = await page.$(".fc, .fc-view, .fc-timegrid, .fc-daygrid");
    if (onCal) return true;
  }

  // 3) Navigate directly (session already authenticated)
  const base = await page.evaluate(() => location.origin);
  for (const path of ["/calendar", "/schedules", "/agenda"]) {
    try {
      const url = base + path;
      dbg("Direct nav →", url);
      await page.goto(url, { waitUntil: "networkidle0", timeout: 15000 });
      const onCal = await page.$(".fc, .fc-view, .fc-timegrid, .fc-daygrid");
      if (onCal) return true;
    } catch {}
  }

  throw new Error("Could not navigate to calendar; menu/link not found.");
}

// ---------- Date navigation (tries input[data-date] & FC toolbar) ----------
async function gotoDate(page, isoDate, DEBUG = false) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);
  dlog("📅 gotoDate →", isoDate);

  // Try native date inputs first
  const dateInputs = [
    'input[type="date"]',
    'input[name="date"]',
    'input[aria-label*="fecha" i]',
    'input[placeholder*="fecha" i]'
  ];
  for (const sel of dateInputs) {
    const exists = await page.$(sel);
    if (exists) {
      dlog("  Using date input:", sel);
      await page.evaluate(
        (selector, value) => {
          const inp = document.querySelector(selector);
          if (!inp) return;
          inp.value = value;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        },
        sel,
        isoDate
      );
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      return true;
    }
  }

  // Click the cell with data-date or navlink
  const tryOpen = async () => {
    const sels = [
      `td[data-date="${isoDate}"]`,
      `a[data-navlink="${isoDate}"]`,
      `th [data-date="${isoDate}"]`,
      `.fc-col-header [data-date="${isoDate}"] a`
    ];
    for (const s of sels) {
      const el = await page.$(s);
      if (el) {
        dlog("  Clicking date element:", s);
        await el.click();
        await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  const clickBtn = async (selectors) => {
    for (const s of selectors) {
      const btn = await page.$(s);
      if (btn) {
        dlog("  Nav button:", s);
        await btn.click();
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  if (await tryOpen()) return true;
  for (let i = 0; i < 24; i++) {
    const moved = await clickBtn([
      ".fc-next-button",
      'button[title="Next"]',
      'button[aria-label*="Next" i]',
      "#calendar .fc-toolbar .fc-next-button"
    ]);
    if (!moved) break;
    if (await tryOpen()) return true;
  }
  for (let i = 0; i < 24; i++) {
    const moved = await clickBtn([
      ".fc-prev-button",
      'button[title="Prev"]',
      'button[aria-label*="Prev" i]',
      "#calendar .fc-toolbar .fc-prev-button"
    ]);
    if (!moved) break;
    if (await tryOpen()) return true;
  }

  throw new Error(`Could not navigate calendar to ${isoDate}.`);
}

// ---------- Modal & form gating ----------
async function closeModalIfOpen(page, DEBUG = false) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);
  const safeCloseSelectors = [
    '#schedule_modal_container button.close',
    '#schedule_modal_container [data-bs-dismiss="modal"]',
    ".modal [data-bs-dismiss=\"modal\"]",
    ".modal .btn-close"
  ];
  for (const sel of safeCloseSelectors) {
    const el = await page.$(sel);
    if (el) {
      const text = (await page.evaluate((e) => e.textContent || "", el))
        .toLowerCase()
        .trim();
      if (["cancelar clase", "eliminar", "borrar", "delete", "remove"].some((k) => text.includes(k))) {
        dlog("  Skipping destructive:", text);
        continue;
      }
      dlog("  Closing modal via:", sel);
      await el.click();
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 4000 }).catch(() => {});
      return;
    }
  }
  dlog("  Closing modal via Escape");
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);
}

async function modalMatchesTarget(page, TARGET_TIME, TARGET_NAME, STRICT_REQUIRE_NAME, DEBUG = false) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);
  await page.waitForSelector("#schedule_modal_container, .modal", { visible: true, timeout: TIMEOUT });
  await sleep(500);
  const raw = await page.evaluate(() => {
    const n = document.querySelector("#schedule_modal_container") || document.querySelector(".modal");
    return n?.innerText || "";
  });
  const txt = normTimeTokens(raw);
  const startMins = extractStartTimeMinutes(txt);
  const targetMins = toMinutes(TARGET_TIME);
  const timeOK = startMins === targetMins;
  const nameOK = TARGET_NAME ? txt.toLowerCase().includes(TARGET_NAME.toLowerCase()) : true;
  const isCreateModal =
    !txt.includes("hora de la clase") &&
    !txt.includes("fecha de inicio") &&
    (txt.includes("disciplina") || txt.includes("cupo fitpass"));
  if (isCreateModal) return false;
  return STRICT_REQUIRE_NAME ? timeOK && nameOK : timeOK && nameOK;
}

async function formMatchesTarget(
  page,
  TARGET_DATE,
  TARGET_TIME,
  TARGET_NAME,
  STRICT_REQUIRE_NAME,
  DEBUG = false
) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);
  const selectorCandidates = [
    '[id^="schedule_form_"]',
    'form[action*="schedules"]',
    "#schedule_modal_container form",
    ".modal form",
    "form"
  ];
  let raw = "";
  for (const sel of selectorCandidates) {
    const el = await page.$(sel);
    if (el) {
      raw = await page.evaluate((n) => n.innerText || "", el);
      if (raw) break;
    }
  }
  const txt = normTimeTokens(raw);
  const startMins = extractStartTimeMinutes(txt);
  const targetMins = toMinutes(TARGET_TIME);
  const timeOK = startMins === targetMins;
  const nameOK = TARGET_NAME ? txt.toLowerCase().includes(TARGET_NAME.toLowerCase()) : true;
  const pageTxt = normTimeTokens(await page.evaluate(() => document.body.innerText || ""));
  const dateOK = pageTxt.includes(TARGET_DATE);
  dlog("  [Form check] timeOK:", timeOK, "nameOK:", nameOK, "dateOK:", dateOK);
  return (STRICT_REQUIRE_NAME ? timeOK && nameOK : timeOK && nameOK) && dateOK;
}

// ---------- Find & open correct event ----------
async function openCorrectEvent(page, TARGET_DATE, TARGET_TIME, TARGET_NAME, STRICT_REQUIRE_NAME, DEBUG = false) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);
  await page.waitForSelector(".fc-event, .fc-daygrid-event, .fc-timegrid-event", {
    visible: true,
    timeout: TIMEOUT
  });

  const events = await page.$$(
    ".fc-timegrid-event, .fc-daygrid-event, .fc-event, a.fc-event, a.fc-daygrid-event"
  );

  const sameDate = async (el) =>
    await page.evaluate(
      (node, d) => {
        if (node.closest?.(`[data-date="${d}"]`)) return true;
        let n = node;
        while (n && n !== document.documentElement) {
          if (n.getAttribute) {
            const dd = n.getAttribute("data-date");
            if (dd === d) return true;
            const nav = n.getAttribute("data-navlink");
            if (nav === d) return true;
          }
          n = n.parentNode;
        }
        return false;
      },
      el,
      TARGET_DATE
    );

  const targetMins = toMinutes(TARGET_TIME);
  const dateEvents = [];
  for (const ev of events) {
    if (!(await sameDate(ev))) continue;
    const txt = (await page.evaluate((n) => n.textContent || "", ev)).toLowerCase();
    dateEvents.push({ ev, preview: txt.trim().replace(/\s+/g, " ").slice(0, 160) });
  }
  if (!dateEvents.length) return false;

  const scored = dateEvents
    .map(({ ev, preview }) => {
      const startMins = extractStartTimeMinutes(preview);
      const timeScore =
        startMins === targetMins ? 100 : startMins ? Math.max(0, 100 - Math.abs(startMins - targetMins)) : 0;
      const nameScore = TARGET_NAME ? (preview.includes(TARGET_NAME.toLowerCase()) ? 50 : 0) : 50;
      return { ev, preview, score: timeScore + nameScore };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return false;

  // Scroll + click with fallbacks
  await best.ev.evaluate((n) => n.scrollIntoView({ block: "center", behavior: "instant" }));
  try {
    await best.ev.click();
  } catch {}
  try {
    await page.evaluate(
      (el) => el.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true })),
      best.ev
    );
  } catch {}
  await sleep(100);

  // Gate 1: modal must match
  const okModal = await modalMatchesTarget(page, TARGET_TIME, TARGET_NAME, STRICT_REQUIRE_NAME, DEBUG);
  if (!okModal) {
    await closeModalIfOpen(page, DEBUG);
    await sleep(200);
    return false;
  }

  // Proceed to "EDITAR CLASE"
  await page.waitForSelector("#schedule_modal_container a.btn-primary, .modal a.btn-primary", {
    visible: true,
    timeout: TIMEOUT
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
    page.click("#schedule_modal_container a.btn-primary, .modal a.btn-primary")
  ]);

  // Gate 2: edit form must match
  return await formMatchesTarget(page, TARGET_DATE, TARGET_TIME, TARGET_NAME, STRICT_REQUIRE_NAME, DEBUG);
}

// ---------- Main runner (wraps your working flow) ----------
async function runFitpass({
  email,
  password,
  TARGET_DATE,
  TARGET_TIME,
  TARGET_NAME = "",
  NEW_CAPACITY,
  STRICT_REQUIRE_NAME = true,
  DEBUG = false
}) {
  const dlog = (...a) => DEBUG && console.log("[DEBUG]", ...a);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    defaultViewport: { width: 1440, height: 900 },
    timeout: 120000
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // Extra logs (helpful on Railway)
  page.on("console", (msg) => console.log("[PAGE]", msg.text()));
  page.on("requestfailed", (r) => console.log("[REQ FAIL]", r.url(), r.failure()?.errorText));
  page.on("response", (resp) => {
    if (resp.status() >= 400) console.log("[HTTP " + resp.status() + "]", resp.url());
  });

  const step = async (label, fn) => {
    console.log("➡️ ", label);
    const t = Date.now();
    try {
      const r = await fn();
      console.log("✅", label, Date.now() - t + "ms");
      return r;
    } catch (e) {
      console.error("❌", label, e?.message || e);
      throw e;
    }
  };

  try {
    // 1) Login (your working selectors)
    await step("Open login", () =>
      page.goto("https://admin2.fitpass.com/sessions/new", { waitUntil: "domcontentloaded" })
    );
    await step("Type credentials", async () => {
      await page.waitForSelector("#login_user_email", { visible: true });
      await page.type("#login_user_email", email, { delay: 25 });
      await page.click("#login_user_password");
      await page.type("#login_user_password", password, { delay: 25 });
    });
    await step("Submit login", async () => {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
        page.click("#new_login_user button")
      ]);
      console.log("[DEBUG] URL after login:", await page.url());
    });

    // 2) Calendar nav (robust)
    await step("Go to calendar", () => gotoCalendar(page, { DEBUG }));

    // 3) Date
    await step("Select date " + TARGET_DATE, () => gotoDate(page, TARGET_DATE, DEBUG));

    // 4) Open correct event
    const opened = await step("Open correct event", () =>
      openCorrectEvent(page, TARGET_DATE, TARGET_TIME, TARGET_NAME, STRICT_REQUIRE_NAME, DEBUG)
    );
    if (!opened) throw new Error(`No matching event for ${TARGET_DATE} at "${TARGET_TIME}"${TARGET_NAME ? ` (${TARGET_NAME})` : ""}.`);

    // 5) Set capacity
    await step("Change capacity", async () => {
      await page.waitForSelector("#schedule_lesson_availability", { visible: true, timeout: TIMEOUT });
      await page.click("#schedule_lesson_availability", { clickCount: 3 });
      await page.type("#schedule_lesson_availability", String(NEW_CAPACITY), { delay: 20 });
    });

    // 6) Save
    await step("Save form", async () => {
      await page.waitForSelector('footer button[type="submit"], footer > div:nth-of-type(1) button', {
        visible: true,
        timeout: TIMEOUT
      });
      await Promise.all([
        page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {}),
        page.click('footer button[type="submit"], footer > div:nth-of-type(1) button')
      ]);
    });

    // 7) “Editar solo esta clase”
    await step('Confirm "Editar solo esta clase"', async () => {
      const buttons = await page.$$("div.text-start button");
      if (buttons.length) {
        await Promise.all([
          page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {}),
          buttons[0].click()
        ]);
      } else {
        throw new Error('Could not find "EDITAR SOLO ESTA CLASE" button.');
      }
    });

    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    return {
      ok: true,
      message: `Capacity ${NEW_CAPACITY} set for ${TARGET_DATE} ${TARGET_TIME}${TARGET_NAME ? ` (${TARGET_NAME})` : ""}`
    };
  } catch (err) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------- API: POST /run ----------
app.post("/run", async (req, res) => {
  // Log request
  console.log(`[REQ] POST /run body=`, JSON.stringify(req.body || {}));

  // 55s watchdog to avoid proxy timeouts
  const done = { sent: false };
  const watchdog = setTimeout(() => {
    if (!done.sent) {
      done.sent = true;
      res
        .status(202)
        .json({ ok: false, pending: true, message: "Job still running; check logs for progress." });
    }
  }, 55000);

  try {
    const {
      email,
      password,
      targetDate,
      targetTime,
      targetName = "",
      newCapacity,
      strictRequireName = true,
      debug = false,
      dryRun = false
    } = req.body || {};

    if (!email || !password || !targetDate || !targetTime || newCapacity == null) {
      if (!done.sent) {
        clearTimeout(watchdog);
        done.sent = true;
        return res
          .status(400)
          .json({ ok: false, error: "Missing required fields: email, password, targetDate, targetTime, newCapacity" });
      }
      return;
    }

    if (dryRun) {
      if (!done.sent) {
        clearTimeout(watchdog);
        done.sent = true;
        return res.json({ ok: true, dryRun: true, message: `Would set capacity to ${newCapacity}` });
      }
      return;
    }

    const result = await runFitpass({
      email,
      password,
      TARGET_DATE: targetDate,
      TARGET_TIME: targetTime,
      TARGET_NAME: targetName,
      NEW_CAPACITY: Number(newCapacity),
      STRICT_REQUIRE_NAME: !!strictRequireName,
      DEBUG: !!debug
    });

    if (!done.sent) {
      clearTimeout(watchdog);
      done.sent = true;
      if (result.ok) return res.json(result);
      return res.status(500).json(result);
    }
  } catch (err) {
    if (!done.sent) {
      clearTimeout(watchdog);
      done.sent = true;
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
});

// ---------- Crash guards ----------
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// ---------- Start server ----------
const port = process.env.PORT || 3000;
const host = "0.0.0.0";
app.listen(port, host, () => console.log(`🚀 Server running on ${host}:${port}`));
