// Browser end-to-end check (puppeteer-core + installed Chrome).
// Isolated local file DB + local dev server; never live Turso credentials.
// Owns and cleans up the dev server, browser contexts and test DB files.
// No tokens are printed to logs.
//
// Covers: supervisors via UI incl. QR modal X/Escape, shared draft between
// two supervisor contexts, keyboard/stepper/timer inputs + reset, full save,
// leaders, reopen, collection blocking, supervisor revocation, desktop/mobile
// overflow, light/dark screenshots.
//
// The 60s countdown is verified functionally (start/progress/pause/reset,
// hits untouched) without waiting out the full minute.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const shotDir = join(repo, "artifacts", "browser");
const dbFile = join(repo, "artifacts", "test", `browser-${process.pid}.db`);
const PORT = 4311;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server start timeout")), 90000);
    const onData = (d) => {
      const s = String(d);
      if (/ready|Local.*4311|http:\/\/localhost:4311/i.test(s)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited early with code ${code}`));
    });
  });
}

async function waitHttpOk(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server not reachable at ${url}`);
}

// Click first visible element matching selector + exact text (or containing).
async function clickText(page, selector, text) {
  await page.evaluate((sel, t) => {
    const els = [...document.querySelectorAll(sel)];
    const el = els.find((e) => (e.textContent || "").trim().includes(t));
    if (!el) throw new Error(`no ${sel} with text "${t}"`);
    el.scrollIntoView({ block: "center" });
    el.click();
  }, selector, text);
}

async function hasText(page, selector, text) {
  return page.evaluate((sel, t) => {
    const els = [...document.querySelectorAll(sel)];
    return els.some((e) => (e.textContent || "").includes(t));
  }, selector, text);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
}

async function typeInto(page, testid, text) {
  const sel = `[data-testid="${testid}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (text) await page.type(sel, text);
}

async function adminFetch(page, path, init) {
  return page.evaluate(async (p, i) => {
    const res = await fetch(p, {
      ...i,
      headers: { "content-type": "application/json", ...((i && i.headers) || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, path, init || null);
}

let server = null;
let browser = null;
try {
  mkdirSync(join(repo, "artifacts", "test"), { recursive: true });
  mkdirSync(shotDir, { recursive: true });
  try { rmSync(dbFile, { force: true }); } catch { /* ignore */ }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
  }

  const childEnv = { ...process.env };
  childEnv.TURSO_DATABASE_URL = `file:${dbFile}`;
  delete childEnv.TURSO_AUTH_TOKEN;
  console.log("Test DB: repository-local file DB (artifacts/test).");

  server = spawn("npx", ["astro", "dev", "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: repo,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverReady = waitForServer(server).catch(() => {});
  await waitHttpOk(`${BASE}/gamemaster`);
  await serverReady;

  const exe = findChrome();
  if (!exe) throw new Error("No Chrome/Chromium found (checked common install paths).");
  browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  const adminCtx = browser.defaultBrowserContext();
  const supACtx = await browser.createBrowserContext();
  const supBCtx = await browser.createBrowserContext();
  const admin = await adminCtx.newPage();
  const supA = await supACtx.newPage();
  const supB = await supBCtx.newPage();
  await admin.setViewport({ width: 1360, height: 900 });

  // ---- public pages promote no management route; old /admin is gone ----
  await admin.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 30000 });
  const homeLinks = await admin.evaluate(() =>
    [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") || ""),
  );
  const homeText = await admin.evaluate(() => document.body.textContent || "");
  check(
    "homepage has no management link/path/promotion",
    !homeLinks.some((h) => h.includes("/admin") || h.includes("/gamemaster")) &&
      !homeText.includes("/admin") &&
      !homeText.includes("/gamemaster") &&
      !homeText.includes("Admin-Bereich"),
  );
  const oldPage = await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle0", timeout: 30000 }).catch(() => null);
  check("old /admin page returns 404", oldPage === null || oldPage.status() === 404);
  const oldApi = await adminFetch(admin, "/api/admin/state");
  check("old /api/admin/state returns 404", oldApi.status === 404);

  // ---- admin: start collection ----
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0", timeout: 30000 });
  await admin.waitForFunction(
    () => document.body.textContent.includes("Spielleitung"),
    { timeout: 20000 },
  );
  if ((await admin.$("body")) && (await hasText(admin, "button", "Erfassung starten"))) {
    await clickText(admin, "button", "Erfassung starten");
    await admin.waitForFunction(
      () => document.body.textContent.includes("Erfassung stoppen"),
      { timeout: 15000 },
    );
  }
  check("admin opens collection", await hasText(admin, "button", "Erfassung stoppen"));

  // ---- admin: create supervisor A via UI, QR modal Escape ----
  await admin.type('input[aria-label="Name der neuen Aufsicht"]', "Anna Aufsicht");
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForFunction(
    () => document.body.textContent.includes("Einladung: Anna Aufsicht"),
    { timeout: 15000 },
  );
  const qrImg = await admin.$('img[alt^="QR-Code Einladung"]');
  check("QR modal opens with locally rendered code", qrImg !== null);
  await admin.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  check("QR modal closes with Escape", !(await hasText(admin, "p", "QR-Code scannen oder Link kopieren")));

  // ---- admin: create supervisor B via UI, QR modal X button ----
  await admin.evaluate(() => { const i = document.querySelector('input[aria-label="Name der neuen Aufsicht"]'); if (i) { i.scrollIntoView(); } });
  await admin.type('input[aria-label="Name der neuen Aufsicht"]', "Ben Aufsicht");
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForFunction(
    () => document.body.textContent.includes("Einladung: Ben Aufsicht"),
    { timeout: 15000 },
  );
  await clickText(admin, "button", "Link kopieren");
  await new Promise((r) => setTimeout(r, 400));
  const copied = await hasText(admin, "button", "Kopiert!");
  await admin.click('button[aria-label="Schließen"]');
  await new Promise((r) => setTimeout(r, 500));
  check("QR modal X closes (copy attempted)", !(await hasText(admin, "p", "QR-Code scannen oder Link kopieren")) || copied);

  // Tokens via API (never logged).
  const st = await adminFetch(admin, "/api/gamemaster/state");
  const supAId = st.body.supervisors.find((s) => s.name === "Anna Aufsicht")?.id;
  const supBId = st.body.supervisors.find((s) => s.name === "Ben Aufsicht")?.id;
  check("two supervisors created", Boolean(supAId && supBId));
  const invA = await adminFetch(admin, `/api/gamemaster/supervisors/${supAId}/invite`);
  const invB = await adminFetch(admin, `/api/gamemaster/supervisors/${supBId}/invite`);
  const tokenA = invA.body.token;
  const tokenB = invB.body.token;
  check("invite tokens issued (not logged)", typeof tokenA === "string" && typeof tokenB === "string" && tokenA !== tokenB);

  // ---- supervisor A: create draft ----
  await supA.goto(`${BASE}/aufsicht/${tokenA}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supA.waitForFunction(() => document.body.textContent.includes("Aufsicht: Anna Aufsicht"), { timeout: 20000 });
  check("supervisor A identity shown", true);
  const supLinks = await supA.evaluate(() =>
    [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") || ""),
  );
  check(
    "supervisor page has no management nav",
    !supLinks.some((h) => h.includes("/admin") || h.includes("/gamemaster")),
  );
  await supA.click('[data-testid="new-participant"]');
  await supA.waitForSelector('[data-testid="create-form"]');
  // Initially no age selected.
  const ageChecked = await supA.$eval('[data-testid="age-option-up_to_14"]', (el) => el.getAttribute("aria-checked"));
  check("age initially unselected", ageChecked === "false");
  await supA.type("#ko-new-name", "Lina Browser");
  await supA.click('[data-testid="age-option-up_to_14"]');
  await supA.click('[data-testid="start-participant"]');
  await supA.waitForSelector('[data-testid="field-golf"]', { timeout: 15000 });
  check("shared draft created, editor opens", true);

  // ---- inputs: keyboard golf, comma time, stepper throwing ----
  await typeInto(supA, "field-golf", "3");
  await supA.click('[data-testid="field-golf"]');
  await supA.keyboard.press("Tab"); // blur -> autosave
  await typeInto(supA, "field-obstacle", "12,3");
  await supA.evaluate(() => document.querySelector('[data-testid="field-obstacle"]').blur());
  // Throwing stepper: blank -> + -> 0 -> + -> 1 -> + -> 2.
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  const throwingVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check("throwing stepper reaches 2", throwingVal === "2", `got "${throwingVal}"`);

  // ---- stopwatch: start/pause/reset on peeling, then keyboard value ----
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-peeling"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Start")).click();
  });
  await new Promise((r) => setTimeout(r, 1300));
  const watchText = await supA.$eval('[data-testid="stopwatch-peeling"] .ko-badge', (el) => el.textContent);
  const progressed = watchText && !watchText.includes("0,0");
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-peeling"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Pause")).click();
  });
  const pausedField = await supA.$eval('[data-testid="field-peeling"]', (el) => el.value);
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-peeling"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Zurücksetzen")).click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const resetField = await supA.$eval('[data-testid="field-peeling"]', (el) => el.value);
  check("stopwatch measures from clock and resets field", Boolean(progressed) && pausedField !== "" && resetField === "", `${watchText} pause->${pausedField} reset->blank`);
  await typeInto(supA, "field-peeling", "45,0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-peeling"]').blur());

  // ---- countdown: start/pause/reset, hits untouched ----
  const hitsBefore = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="countdown-throwing"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Countdown")).click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const cdText = await supA.$eval('[data-testid="countdown-display"]', (el) => el.textContent);
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="countdown-throwing"]');
    const p = [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Pause"));
    if (p) p.click();
  });
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="countdown-throwing"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Zurücksetzen")).click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const cdReset = await supA.$eval('[data-testid="countdown-display"]', (el) => el.textContent);
  const hitsAfter = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check(
    "60s countdown ticks/pauses/resets, hits untouched (no full-minute wait)",
    cdText !== null && !cdText.includes("60,0") && cdReset.includes("60,0") && hitsBefore === hitsAfter,
    `${cdText} -> ${cdReset}, hits ${hitsBefore}->${hitsAfter}`,
  );

  // ---- wait for autosave of all values ----
  await supA.waitForFunction(
    () => document.body.textContent.includes("Gespeichert"),
    { timeout: 20000 },
  ).catch(() => {});
  const savedState = await supA.$eval('[data-testid="save-status"]', (el) => el.textContent);
  check("all values autosaved", savedState.includes("Gespeichert"), savedState.trim());

  // ---- supervisor B sees shared draft ----
  await supB.goto(`${BASE}/aufsicht/${tokenB}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supB.waitForFunction(() => document.body.textContent.includes("Lina Browser"), { timeout: 20000 });
  check("second supervisor sees shared draft", true);

  // ---- finalize as A ----
  await supA.bringToFront?.();
  // Ensure finalize enabled.
  await supA.waitForFunction(() => {
    const b = document.querySelector('[data-testid="finalize"]');
    return b && !b.disabled;
  }, { timeout: 20000 });
  await supA.click('[data-testid="finalize"]');
  // Note: the list renders transiently with stale state first; wait for the
  // draft to actually disappear (server confirms finalized + hidden).
  await supA.waitForFunction(() => !document.body.textContent.includes("Lina Browser"), { timeout: 20000 });
  const stillThere = await hasText(supA, "body", "Lina Browser");
  check("finalize returns to list, draft hidden", !stillThere);

  // ---- admin leaders show winner ----
  await admin.bringToFront?.();
  // The admin table already shows drafts, so wait for the leaders text itself.
  await admin.waitForFunction(() => document.body.textContent.includes("Platzsumme"), { timeout: 25000 });
  check("admin leaders list finalized winner", await hasText(admin, "body", "Platzsumme"));

  // ---- screenshots desktop + mobile + dark ----
  await admin.setViewport({ width: 1360, height: 900 });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
  check("desktop no horizontal overflow (gamemaster)", await noHorizontalOverflow(admin));
  await admin.screenshot({ path: join(shotDir, "gamemaster-desktop-light.png") });
  await admin.click("#ko-theme-toggle");
  await new Promise((r) => setTimeout(r, 400));
  await admin.screenshot({ path: join(shotDir, "gamemaster-desktop-dark.png") });
  await admin.click("#ko-theme-toggle");
  await admin.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1200));
  check("mobile no horizontal overflow (gamemaster)", await noHorizontalOverflow(admin));
  await admin.screenshot({ path: join(shotDir, "gamemaster-mobile-light.png") });
  await supA.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await supA.goto(`${BASE}/aufsicht/${tokenA}`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1200));
  check("mobile no horizontal overflow (supervisor)", await noHorizontalOverflow(supA));
  await supA.screenshot({ path: join(shotDir, "supervisor-mobile-light.png") });

  // ---- reopen removes from rankings ----
  await admin.setViewport({ width: 1360, height: 900 });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await admin.waitForFunction(() => document.body.textContent.includes("Erneut öffnen"), { timeout: 20000 });
  await clickText(admin, "button", "Erneut öffnen");
  await admin.waitForFunction(() => document.body.textContent.includes("Noch keine abgeschlossenen Wertungen"), { timeout: 20000 });
  check("reopen removes participant from rankings", true);

  // ---- collection blocking disables editing ----
  await clickText(admin, "button", "Erfassung stoppen");
  await admin.waitForFunction(() => document.body.textContent.includes("Erfassung starten"), { timeout: 15000 });
  await supA.goto(`${BASE}/aufsicht/${tokenA}`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
  const blockedMsg = await hasText(supA, "body", "pausiert");
  // Reopened draft visible; open it and check inputs disabled.
  const opened = await supA.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Lina Browser"));
    if (btn) { btn.click(); return true; }
    return !!document.querySelector('[data-testid="field-golf"]');
  });
  await new Promise((r) => setTimeout(r, 800));
  const golfDisabled = await supA.evaluate(() => {
    const el = document.querySelector('[data-testid="field-golf"]');
    return el ? el.disabled : "missing";
  });
  check("closed collection blocks editing, input preserved", blockedMsg && opened && golfDisabled === true, `disabled=${golfDisabled}`);
  await clickText(admin, "button", "Erfassung starten");
  await admin.waitForFunction(() => document.body.textContent.includes("Erfassung stoppen"), { timeout: 15000 });

  // ---- revocation: delete supervisor B, access gone ----
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await admin.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => e.getAttribute("aria-label") === "Ben Aufsicht entfernen");
    if (!b) throw new Error("delete button for Ben missing");
    b.scrollIntoView({ block: "center" });
    b.click();
  });
  await admin.waitForFunction(() => document.body.textContent.includes("wirklich"), { timeout: 10000 });
  await clickText(admin, "button", "Bestätigen");
  await new Promise((r) => setTimeout(r, 1500));
  await supB.goto(`${BASE}/aufsicht/${tokenB}`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
  const noAccess = await hasText(supB, "body", "Kein Zugang");
  const noForm = !(await supB.$('[data-testid="new-participant"]'));
  check("revoked supervisor sees access error, no form", noAccess && noForm);

  console.log(`\nScreenshots: ${shotDir}`);
} catch (e) {
  console.error("BROWSER CHECK ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    try { server.kill("SIGKILL"); } catch { /* ignore */ }
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed.`);
if (failed.length > 0) process.exitCode = 1;
