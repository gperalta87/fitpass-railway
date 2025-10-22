import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/", (_req, res) => res.send("✅ Fitpass automation online"));

// POST /run with JSON body
app.post("/run", async (req, res) => {
  const {
    email,
    password,
    targetDate,
    targetTime,
    targetName = "",
    newCapacity = 3,
    strictRequireName = true,
    debug = false
  } = req.body;

  if (!email || !password || !targetDate || !targetTime) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ],
      defaultViewport: { width: 1440, height: 900 }
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(45000);

    // --- LOGIN ---
    await page.goto(process.env.LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => {});

    // --- SELECT DATE ---
    const daySel = `[data-date="${targetDate}"]`;
    await page.waitForSelector(daySel, { timeout: 60000 });
    await page.click(daySel);
    await page.waitForTimeout(1000);

    // --- FIND CLASS ---
    const rows = await page.$$('[data-testid="class-row"], .class-row, .class-item');
    let chosen = null;
    for (const row of rows) {
      const timeTxt = await page.evaluate(el => el.textContent, await row.$('.time'));
      const nameTxt = await page.evaluate(el => el.textContent, await row.$('.name'));
      const timeOK = (timeTxt || "").includes(targetTime);
      const nameOK = !targetName || (nameTxt || "").toLowerCase().includes(targetName.toLowerCase());
      if (timeOK && (nameOK || !strictRequireName)) { chosen = row; break; }
    }

    if (!chosen) throw new Error("Class not found");

    // --- OPEN EDITOR ---
    await chosen.click();
    await page.waitForSelector('input[name="capacity"], #capacity', { timeout: 30000 });

    // --- UPDATE CAPACITY ---
    await page.click('input[name="capacity"], #capacity', { clickCount: 3 });
    await page.keyboard.type(String(newCapacity));
    await page.click('button[type="submit"], .btn-primary');

    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    await browser.close();

    res.json({ ok: true, message: "Capacity updated" });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on ${port}`));
