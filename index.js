import puppeteer from "puppeteer";

/**
 * =========================
 *  Env configuration
 * =========================
 */
const ENV = {
  // Required
  LOGIN_URL: must("LOGIN_URL"),        // e.g. https://partners.fitpass.mx/login  (put the real login URL)
  EMAIL: must("EMAIL"),
  PASSWORD: must("PASSWORD"),
  TARGET_DATE: must("TARGET_DATE"),    // YYYY-MM-DD (portal date should match this pattern)
  TARGET_TIME: must("TARGET_TIME"),    // e.g. 07:00 (24h) or 07:00 a.m. depending on portal text
  NEW_CAPACITY: parseInt(must("NEW_CAPACITY"), 10),

  // Optional refiners
  TARGET_NAME: opt("TARGET_NAME", ""), // e.g. "ponte reformer" (empty = ignore name)
  STRICT_REQUIRE_NAME: opt("STRICT_REQUIRE_NAME", "true") === "true",
  DEBUG: opt("DEBUG", "false") === "true",

  // Optional selector overrides (defaults fit many portals; override if needed)
  SEL_EMAIL: opt("SEL_EMAIL", 'input[name="email"], input[type="email"], #email'),
  SEL_PASSWORD: opt("SEL_PASSWORD", 'input[name="password"], input[type="password"], #password'),
  SEL_SUBMIT: opt("SEL_SUBMIT", 'button[type="submit"], button[data-testid="login"], .btn-primary'),

  // After login, where the classes schedule lives (if login redirects directly, leave empty)
  SCHEDULE_URL: opt("SCHEDULE_URL", ""), // e.g. https://partners.fitpass.mx/schedule

  // Calendar/date & classes listing assumptions (override as needed)
  // calendar cells like: <td data-date="2025-10-21">…</td>
  SEL_DAY_CELL: opt("SEL_DAY_CELL", 'td[data-date="%YYYY-MM-DD%"], [data-date="%YYYY-MM-DD%"]'),

  // Each class row/card selector:
  SEL_CLASS_ROW: opt("SEL_CLASS_ROW", '[data-testid="class-row"], .class-row, .class-item, li[role="row"]'),

  // Where the time & name appear inside a class row:
  SEL_CLASS_TIME: opt("SEL_CLASS_TIME", '.time, [data-testid="class-time"], .class-time'),
  SEL_CLASS_NAME: opt("SEL_CLASS_NAME", '.name, [data-testid="class-name"], .class-name'),

  // Button to open/edit a class
  SEL_CLASS_OPEN: opt("SEL_CLASS_OPEN", 'button:has-text("Editar"), a:has-text("Editar"), [data-testid="edit-class"], .edit'),

  // Capacity input and save button inside the edit modal/page
  SEL_CAPACITY_INPUT: opt("SEL_CAPACITY_INPUT", 'input[name="capacity"], #capacity, [data-testid="capacity"]'),
  SEL_SAVE: opt("SEL_SAVE", 'button[type="submit"], button:has-text("Guardar"), [data-testid="save"], .btn-primary'),
};

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[ENV] Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}
function opt(name, def) {
  return process.env[name] ?? def;
}

const log = (...a) => console.log(...a);
const dbg = (...a) => ENV.DEBUG && console.log("[DEBUG]", ...a);

/**
 * =========================
 *  Helpers
 * =========================
 */
async function waitAndType(page, selector, value, label = selector) {
  await page.waitForSelector(selector, { timeout: 30000 });
  await page.click(selector, { delay: 20 });
  await page.keyboard.type(value, { delay: 20 });
  dbg(`Typed into ${label}`);
}

async function clickWhenReady(page, selector, label = selector) {
  await page.waitForSelector(selector, { timeout: 30000 });
  await page.click(selector, { delay: 30 });
  dbg(`Clicked ${label}`);
}

function normalizeText(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function timeMatches(textTime, targetTime) {
  // Accept exact match OR contains (to allow "07:00 a.m. - 07:50 a.m.")
  const norm = normalizeText(textTime);
  const t = normalizeText(targetTime);
  return norm === t || norm.includes(t);
}

function nameMatches(textName, targetName) {
  if (!targetName) return true;
  const n = normalizeText(textName);
  const t = normalizeText(targetName);
  return n.includes(t);
}

/**
 * =========================
 *  Main job
 * =========================
 */
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    defaultViewport: { width: 1440, height: 900 },
    timeout: 120000
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  try {
    // 1) Login
    log("🔐 Logging in…");
    await page.goto(ENV.LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitAndType(page, ENV.SEL_EMAIL, ENV.EMAIL, "email");
    await waitAndType(page, ENV.SEL_PASSWORD, ENV.PASSWORD, "password");
    await clickWhenReady(page, ENV.SEL_SUBMIT, "login");

    // Let redirects/SPA load
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    dbg("Logged in, navigation settled");

    // 2) Go to schedule (if provided)
    if (ENV.SCHEDULE_URL) {
      log("🗓️  Opening schedule…");
      await page.goto(ENV.SCHEDULE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    }

    // 3) Select date
    log(`📅 Selecting date ${ENV.TARGET_DATE}…`);
    const daySelector = ENV.SEL_DAY_CELL.replace("%YYYY-MM-DD%", ENV.TARGET_DATE);
    await page.waitForSelector(daySelector, { timeout: 60000 });
    await page.click(daySelector, { delay: 30 });
    await page.waitForTimeout(1000); // give UI a sec to refresh classes

    // 4) Scan classes on that date
    log(`🔎 Looking for class at ${ENV.TARGET_TIME}${ENV.TARGET_NAME ? " / " + ENV.TARGET_NAME : ""}…`);
    await page.waitForSelector(ENV.SEL_CLASS_ROW, { timeout: 30000 });
    const classHandles = await page.$$(ENV.SEL_CLASS_ROW);

    if (!classHandles.length) throw new Error("No classes found for that date.");

    let chosen = null;
    for (const row of classHandles) {
      const timeEl = await row.$(ENV.SEL_CLASS_TIME);
      const nameEl = await row.$(ENV.SEL_CLASS_NAME);

      const timeTxt = timeEl ? (await page.evaluate(el => el.textContent, timeEl)) : "";
      const nameTxt = nameEl ? (await page.evaluate(el => el.textContent, nameEl)) : "";

      dbg("Candidate:", { timeTxt, nameTxt });

      const timeOK = timeMatches(timeTxt, ENV.TARGET_TIME);
      const nameOK = nameMatches(nameTxt, ENV.TARGET_NAME);

      if (timeOK && (nameOK || !ENV.STRICT_REQUIRE_NAME)) {
        chosen = row;
        break;
      }
    }

    if (!chosen) {
      throw new Error(
        `No matching class found for time="${ENV.TARGET_TIME}"` +
        (ENV.TARGET_NAME ? ` and name~="${ENV.TARGET_NAME}"` : "") +
        (ENV.STRICT_REQUIRE_NAME ? " (strict name on)" : " (strict name off)")
      );
    }

    // 5) Open the class editor
    log("📝 Opening class editor…");
    let openBtn = await chosen.$(ENV.SEL_CLASS_OPEN);
    if (!openBtn) {
      // fallback: click the row itself
      await chosen.click({ delay: 30 });
    } else {
      await openBtn.click({ delay: 30 });
    }

    // Wait for modal or editor page
    await page.waitForSelector(ENV.SEL_CAPACITY_INPUT, { timeout: 30000 });

    // 6) Update capacity
    log(`📈 Setting capacity to ${ENV.NEW_CAPACITY}…`);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.focus();
    }, ENV.SEL_CAPACITY_INPUT);

    await page.click(ENV.SEL_CAPACITY_INPUT, { clickCount: 3, delay: 20 });
    await page.keyboard.type(String(ENV.NEW_CAPACITY), { delay: 20 });

    // 7) Save
    await clickWhenReady(page, ENV.SEL_SAVE, "save");
    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    log("✅ Done. Capacity updated.");

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err?.message || err);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
