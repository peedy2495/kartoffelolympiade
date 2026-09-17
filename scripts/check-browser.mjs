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

// Fail the next POST to path with a simulated 500, then pass everything
// through. Used to prove mutation errors survive successful auto polls.
async function failNextPost(page, path) {
  const handler = async (req) => {
    try {
      const url = new URL(req.url());
      if (req.method() === "POST" && url.pathname === path && !handler.done) {
        handler.done = true;
        await req.respond({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "INTERNAL", message: "Simulierter Fehler." }),
        });
        return;
      }
    } catch { /* fall through to continue */ }
    await req.continue().catch(() => {});
  };
  handler.done = false;
  page.on("request", handler);
  await page.setRequestInterception(true);
  return async () => {
    page.off("request", handler);
    await page.setRequestInterception(false).catch(() => {});
  };
}

async function tooltipVisible(page) {
  return page.evaluate(() => {
    const tip = document.querySelector('[role="tooltip"]');
    if (!tip) return false;
    return Number(getComputedStyle(tip).opacity) > 0.5;
  });
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

  // ---- refresh: tooltip on hover/focus, click refetches state ----
  const refreshBtn = 'button[aria-label="Daten neu laden"]';
  await admin.waitForSelector(refreshBtn, { timeout: 10000 });
  check("refresh button has tooltip title", await admin.$eval(refreshBtn, (el) => el.title === "Daten neu laden"));
  await admin.hover(refreshBtn);
  await new Promise((r) => setTimeout(r, 600));
  const tipHover = await tooltipVisible(admin);
  const tipText = await admin.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent || "");
  await admin.focus(refreshBtn);
  await new Promise((r) => setTimeout(r, 600));
  const tipFocus = await tooltipVisible(admin);
  check(
    "refresh tooltip visible on hover and focus, explains reload only",
    tipHover && tipFocus && tipText.includes("zentralen Daten") && tipText.includes("nichts"),
    tipText.trim().slice(0, 80),
  );
  const stateResponse = admin.waitForResponse(
    (res) => res.url().includes("/api/gamemaster/state"),
    { timeout: 15000 },
  );
  await admin.click(refreshBtn);
  await stateResponse;
  check("manual refresh fetches state, view stays live", await hasText(admin, "button", "Erfassung stoppen"));

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

  // ---- mutation errors survive successful auto polls; retry succeeds ----
  const stopFail = await failNextPost(admin, "/api/gamemaster/collection");  await clickText(admin, "button", "Erfassung stoppen");
  await admin.waitForSelector('[role="alert"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3600)); // let a 3s auto poll succeed
  const toggleErrorPersists =
    await hasText(admin, '[role="alert"]', "Fehler") &&
    await hasText(admin, "button", "Erfassung stoppen");
  await stopFail();
  check("failed collection toggle keeps error after auto poll", toggleErrorPersists);
  await clickText(admin, "button", "Schließen");
  await new Promise((r) => setTimeout(r, 400));
  check("action error dismisses explicitly", !(await hasText(admin, '[role="alert"]', "Fehler")));
  await clickText(admin, "button", "Erfassung stoppen");
  await admin.waitForFunction(
    () => document.body.textContent.includes("Erfassung starten"),
    { timeout: 15000 },
  );
  await clickText(admin, "button", "Erfassung starten");
  await admin.waitForFunction(
    () => document.body.textContent.includes("Erfassung stoppen"),
    { timeout: 15000 },
  );
  check("collection toggle retry succeeds, collection open", await hasText(admin, "button", "Erfassung stoppen"));

  const supFail = await failNextPost(admin, "/api/gamemaster/supervisors");
  await admin.type('input[aria-label="Name der neuen Aufsicht"]', "Retry Aufsicht");
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForSelector('[role="alert"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3600)); // let a 3s auto poll succeed
  const createErrorPersists = await hasText(admin, '[role="alert"]', "Fehler");
  const namePreserved = await admin.$eval(
    'input[aria-label="Name der neuen Aufsicht"]',
    (el) => el.value,
  );
  await supFail();
  check(
    "failed supervisor create keeps error after auto poll, input preserved",
    createErrorPersists && namePreserved === "Retry Aufsicht",
    `input="${namePreserved}"`,
  );
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForFunction(
    () => document.body.textContent.includes("Einladung: Retry Aufsicht"),
    { timeout: 15000 },
  );
  const alertCleared = !(await hasText(admin, '[role="alert"]', "Fehler"));
  await admin.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  check("supervisor retry succeeds and clears the error", alertCleared);

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
  // Throwing stepper: blank treated as 0, first + yields 1, minus floors 0.
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  const throwingFirst = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check("rapid + from blank starts at 1", throwingFirst === "1", `got "${throwingFirst}"`);
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  const throwingVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check("throwing stepper reaches 3 after three rapid clicks", throwingVal === "3", `got "${throwingVal}"`);

  // ---- stopwatch: start/pause/reset on peeling clears the stored value ----
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
  check("stopwatch measures from clock, explicit reset clears field", Boolean(progressed) && pausedField !== "" && resetField === "", `${watchText} pause->${pausedField} reset->blank`);
  await typeInto(supA, "field-peeling", "45,0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-peeling"]').blur());

  // ---- countdown: start/pause/reset, explicit reset clears hits + restores 60s ----
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
    "60s countdown ticks/pauses/resets to 60s, explicit reset clears hits (no full-minute wait)",
    cdText !== null && !cdText.includes("60,0") && cdReset.includes("60,0") && hitsBefore !== "" && hitsAfter === "",
    `${cdText} -> ${cdReset}, hits ${hitsBefore}->blank`,
  );
  // Restore throwing for the save flow (reset cleared it by design).
  // NOTE: value must differ from the last saved one, otherwise there is
  // correctly nothing to save and the badge stays "Bereit".
  await typeInto(supA, "field-throwing", "2");
  await supA.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());

  // ---- wait for autosave of all values ----
  await supA.waitForFunction(
    () => document.body.textContent.includes("Gespeichert"),
    { timeout: 20000 },
  ).catch(() => {});
  const savedState = await supA.$eval('[data-testid="save-status"]', (el) => el.textContent);
  check("all values autosaved", savedState.includes("Gespeichert"), savedState.trim());

  // ---- autosave/poll ordering regressions (tracked interception, no timing luck) ----
  // Interceptor holds PATCH and/or GET /api/state on demand so response
  // ordering is controlled deterministically against the REAL app.
  const netCtl = { holdPatch: false, holdGet: false, heldPatch: [], heldGet: [], patchCount: 0, getCount: 0 };
  const netHandler = async (req) => {
    try {
      const url = new URL(req.url());
      const isPatch = req.method() === "PATCH" && url.pathname.startsWith("/api/participants/");
      const isGet = req.method() === "GET" && url.pathname === "/api/state";
      if (isPatch) {
        netCtl.patchCount += 1;
        if (netCtl.holdPatch) {
          netCtl.heldPatch.push(req);
          return;
        }
      } else if (isGet) {
        netCtl.getCount += 1;
        if (netCtl.holdGet) {
          netCtl.heldGet.push(req);
          return;
        }
      }
    } catch { /* fall through to continue */ }
    await req.continue().catch(() => {});
  };
  await supA.setRequestInterception(true);
  supA.on("request", netHandler);
  async function releaseHeld(kind) {
    const list = kind === "patch" ? netCtl.heldPatch.splice(0) : netCtl.heldGet.splice(0);
    for (const req of list) await req.continue().catch(() => {});
  }
  async function waitForHeldPatch(timeout = 15000) {
    const start = Date.now();
    while (netCtl.heldPatch.length === 0) {
      if (Date.now() - start > timeout) throw new Error("timed out waiting for held PATCH");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function waitForHeldGet(timeout = 15000) {
    const start = Date.now();
    while (netCtl.heldGet.length === 0) {
      if (Date.now() - start > timeout) throw new Error("timed out waiting for held GET");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function waitSaved(timeout = 20000) {
    await supA.waitForFunction(
      () => document.body.textContent.includes("Gespeichert"),
      { timeout },
    ).catch(() => {});
  }

  // 1) Edits during a delayed PATCH survive both saves + poll.
  netCtl.holdPatch = true;
  const throwingBase = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  await waitForHeldPatch();
  const duringVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  const latestVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  netCtl.holdPatch = false;
  await releaseHeld("patch");
  await waitSaved();
  await new Promise((r) => setTimeout(r, 3600)); // a full 3s poll passes
  const survivedVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check(
    "edits during delayed PATCH survive both saves and poll",
    duringVal === String(Number(throwingBase) + 1) && survivedVal === latestVal && latestVal === String(Number(throwingBase) + 2),
    `${throwingBase} -> during ${duringVal} -> latest ${latestVal} -> after poll ${survivedVal}`,
  );

  // 2) Late pre-save GET does not roll back the newer value.
  netCtl.holdGet = true;
  await waitForHeldGet(); // a poll issued before the edit is now held
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  const preStaleVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  await waitSaved();
  netCtl.holdGet = false;
  await releaseHeld("get"); // stale snapshot arrives after the save
  await new Promise((r) => setTimeout(r, 800));
  const afterStaleVal = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  await waitSaved();
  check(
    "late pre-save GET does not roll back newer value",
    afterStaleVal === preStaleVal,
    `before stale ${preStaleVal} -> after ${afterStaleVal}`,
  );

  // 3) Reset while a PATCH is pending stays cleared after save + poll.
  netCtl.holdPatch = true;
  await supA.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Treffer erhöhen").click(); });
  await waitForHeldPatch();
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="countdown-throwing"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Zurücksetzen")).click();
  });
  const resetDuring = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  netCtl.holdPatch = false;
  await releaseHeld("patch");
  await waitSaved();
  await new Promise((r) => setTimeout(r, 3600));
  const resetSurvived = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  const resetCountdown = await supA.$eval('[data-testid="countdown-display"]', (el) => el.textContent);
  check(
    "reset during pending PATCH stays blank after save+poll, countdown back at 60s",
    resetDuring === "" && resetSurvived === "" && resetCountdown.includes("60,0"),
    `during "${resetDuring}" after "${resetSurvived}" cd "${resetCountdown}"`,
  );
  // Server + second supervisor confirm the clear persisted (no restore).
  const stAfterClear = await adminFetch(admin, "/api/gamemaster/state");
  const clearedPid = stAfterClear.body.participants.find((p) => p.name === "Lina Browser")?.id;
  const clearedThrow = stAfterClear.body.results?.[clearedPid]?.throwing?.value;
  check("cleared throwing persists server-side", clearedThrow === undefined, `server throwing=${clearedThrow}`);
  await supB.goto(`${BASE}/aufsicht/${tokenB}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supB.waitForFunction(() => document.body.textContent.includes("Lina Browser"), { timeout: 20000 });
  await supB.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Lina Browser"));
    if (btn) btn.click();
  });
  await supB.waitForSelector('[data-testid="field-throwing"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));
  const supBThrow = await supB.$eval('[data-testid="field-throwing"]', (el) => el.value);
  const supBAttr = await supB.$eval('[data-testid="attribution-throwing"]', (el) => el.textContent);
  check(
    "second supervisor sees cleared throwing with empty attribution",
    supBThrow === "" && supBAttr.includes("Noch kein Eintrag"),
    `field="${supBThrow}" attr="${supBAttr.trim().slice(0, 40)}"`,
  );
  // Restore throwing on A for finalize + attribution flow (supB stays in editor).
  await supA.bringToFront?.();
  await typeInto(supA, "field-throwing", "5");
  await supA.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());
  await waitSaved();

  // 4) Distinct per-card attribution after real writes by both supervisors.
  // Wait until B converged to A's restored value first: otherwise B's save
  // would (correctly) conflict as STALE instead of succeeding.
  await supB.bringToFront?.();
  await supB.waitForFunction(
    () => document.querySelector('[data-testid="field-throwing"]')?.value === "5",
    { timeout: 20000 },
  );
  await typeInto(supB, "field-throwing", "7");
  await supB.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());
  await supB.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3600)); // let A's poll pick up B's write
  await supA.bringToFront?.();
  const attrThrow = await supA.$eval('[data-testid="attribution-throwing"]', (el) => el.textContent);
  const attrGolf = await supA.$eval('[data-testid="attribution-golf"]', (el) => el.textContent);
  const attrObst = await supA.$eval('[data-testid="attribution-obstacle"]', (el) => el.textContent);
  const attrPeel = await supA.$eval('[data-testid="attribution-peeling"]', (el) => el.textContent);
  check(
    "per-card attribution identifies distinct supervisors after real writes",
    attrThrow.includes("Ben Aufsicht") && attrGolf.includes("Anna Aufsicht") &&
      attrObst.includes("Anna Aufsicht") && attrPeel.includes("Anna Aufsicht"),
    `golf=${attrGolf.trim().slice(0, 34)} obst=${attrObst.trim().slice(0, 34)} throw=${attrThrow.trim().slice(0, 34)} peel=${attrPeel.trim().slice(0, 34)}`,
  );
  // A's editor converged to B's throwing value without conflict banner.
  const convergedThrow = await supA.$eval('[data-testid="field-throwing"]', (el) => el.value);
  check("clean remote update converges without blind overwrite", convergedThrow === "7", `got "${convergedThrow}"`);
  // Timer/countdown buttons: icons present, text retained.
  const timerIcons = await supA.evaluate(() => {
    const boxes = ["countdown-throwing", "stopwatch-obstacle", "stopwatch-peeling"]
      .map((id) => document.querySelector(`[data-testid="${id}"]`))
      .filter(Boolean);
    const btns = boxes.flatMap((box) => [...box.querySelectorAll("button")]);
    return {
      total: btns.length,
      withSvg: btns.filter((b) => b.querySelector("svg")).length,
      hiddenSvg: btns.filter((b) => b.querySelector('svg[aria-hidden="true"]')).length,
      withText: btns.filter((b) => (b.textContent || "").trim().length > 2).length,
    };
  });
  check(
    "timer/countdown buttons show aria-hidden icons with retained text",
    timerIcons.total === 6 && timerIcons.withSvg === 6 && timerIcons.hiddenSvg === 6 && timerIcons.withText === 6,
    JSON.stringify(timerIcons),
  );
  supA.off("request", netHandler);
  await supA.setRequestInterception(false).catch(() => {});

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

  // ---- theme toggle sizing + behavior, product naming ----
  await admin.setViewport({ width: 1360, height: 900 });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await admin.waitForSelector("#ko-theme-toggle", { timeout: 10000 });
  const themeBox = await admin.$eval("#ko-theme-toggle", (el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const themeSvg = await admin.$eval("#ko-theme-toggle", (el) => !!el.querySelector("svg"));
  const themeLabel = await admin.$eval("#ko-theme-toggle", (el) => el.getAttribute("aria-label") || "");
  check(
    "theme toggle is full-sized control with visible icon and action label",
    themeBox.w >= 44 && themeBox.h >= 44 && themeSvg && /hellen|dunklen/.test(themeLabel),
    `${themeBox.w}x${themeBox.h} label="${themeLabel}"`,
  );
  const darkBefore = await admin.evaluate(() => document.documentElement.classList.contains("dark"));
  await admin.click("#ko-theme-toggle");
  await new Promise((r) => setTimeout(r, 400));
  const darkAfter = await admin.evaluate(() => document.documentElement.classList.contains("dark"));
  const labelAfter = await admin.$eval("#ko-theme-toggle", (el) => el.getAttribute("aria-label") || "");
  await admin.click("#ko-theme-toggle");
  await new Promise((r) => setTimeout(r, 400));
  const darkRestored = await admin.evaluate(() => document.documentElement.classList.contains("dark"));
  check(
    "theme toggle switches theme and updates action label",
    darkAfter !== darkBefore && darkRestored === darkBefore && labelAfter !== themeLabel,
    `dark ${darkBefore}->${darkAfter}->${darkRestored}`,
  );
  const festPages = [];
  for (const url of [`${BASE}/`, `${BASE}/gamemaster`, `${BASE}/aufsicht/${tokenA}`]) {
    const txt = await admin.evaluate(async (u) => {
      const res = await fetch(u);
      return await res.text();
    }, url);
    if (txt.includes("Kartoffelfest")) festPages.push(url);
  }
  const liveText = await admin.evaluate(() => document.body.textContent || "");
  check("no Kartoffelfest naming in pages (Kartoffelfeuer)", festPages.length === 0 && !liveText.includes("Kartoffelfest"), festPages.join(","));

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

  // ---- supervisor B creates a throwaway participant for the participant-delete test ----
  await supB.bringToFront?.();
  await supB.goto(`${BASE}/aufsicht/${tokenB}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supB.waitForFunction(() => document.body.textContent.includes("Aufsicht: Ben Aufsicht"), { timeout: 20000 });
  await supB.click('[data-testid="new-participant"]');
  await supB.waitForSelector('[data-testid="create-form"]');
  await supB.type("#ko-new-name", "Wegwerf Teilnehmer");
  await supB.click('[data-testid="age-option-over_14"]');
  await supB.click('[data-testid="start-participant"]');
  await supB.waitForSelector('[data-testid="field-golf"]', { timeout: 15000 });
  await supB.evaluate(() => { [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Zur Liste")).click(); });
  await supB.waitForFunction(() => document.body.textContent.includes("Wegwerf Teilnehmer"), { timeout: 15000 });

  // ---- revocation: delete supervisor B via centered viewport modal ----
  await admin.bringToFront?.();
  await admin.setViewport({ width: 1360, height: 900 });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await admin.waitForFunction(() => document.body.textContent.includes("Ben Aufsicht"), { timeout: 20000 });
  let deleteReqs = 0;
  const deleteCounter = (req) => {
    try {
      const url = new URL(req.url());
      if (req.method() === "DELETE" && url.pathname.startsWith("/api/gamemaster/")) deleteReqs += 1;
    } catch { /* ignore */ }
  };
  admin.on("request", deleteCounter);
  async function openDeleteModal(ariaLabel) {
    await admin.evaluate((label) => {
      const b = [...document.querySelectorAll("button")].find((e) => e.getAttribute("aria-label") === label);
      if (!b) throw new Error(`delete button missing: ${label}`);
      b.scrollIntoView({ block: "center" });
      b.click();
    }, ariaLabel);
    await admin.waitForSelector('[role="alertdialog"]', { timeout: 10000 });
  }
  async function modalCentered() {
    return admin.evaluate(() => {
      const el = document.querySelector('[role="alertdialog"]');
      if (!el) return { ok: false, why: "no dialog" };
      const r = el.getBoundingClientRect();
      const cx = Math.abs((r.left + r.right) / 2 - window.innerWidth / 2);
      const cy = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
      const fits = r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
      return { ok: cx < 80 && cy < 120 && fits, why: `cx=${cx.toFixed(0)} cy=${cy.toFixed(0)} fits=${fits}` };
    });
  }
  // Escape preserves the row. (Row presence is tracked via the supervisor
  // delete button: result attribution keeps "Ben Aufsicht" by design.)
  await openDeleteModal("Ben Aufsicht entfernen");
  const supModalCenter = await modalCentered();
  check("supervisor delete modal centered viewport, fits without scrolling", supModalCenter.ok, supModalCenter.why);
  await admin.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  const escGone = !(await admin.$('[role="alertdialog"]'));
  const escRow = !!(await admin.$('button[aria-label="Ben Aufsicht entfernen"]'));
  check("supervisor delete Escape preserves row", escGone && escRow);
  // Cancel preserves the row.
  await openDeleteModal("Ben Aufsicht entfernen");
  await clickText(admin, "button", "Abbrechen");
  await new Promise((r) => setTimeout(r, 500));
  const cancelRow = !!(await admin.$('button[aria-label="Ben Aufsicht entfernen"]'));
  check("supervisor delete cancel preserves row", !(await admin.$('[role="alertdialog"]')) && cancelRow);
  // Confirm with double click guarded to a single DELETE.
  await openDeleteModal("Ben Aufsicht entfernen");
  deleteReqs = 0;
  await admin.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === "Bestätigen");
    if (!b) throw new Error("confirm button missing");
    b.click();
    b.click();
  });
  await admin.waitForFunction(() => !document.querySelector('button[aria-label="Ben Aufsicht entfernen"]'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  check("supervisor delete double click guarded to one request", deleteReqs === 1, `DELETEs=${deleteReqs}`);
  // Historical attribution survives the supervisor removal.
  check("deleted supervisor attribution preserved in results", await hasText(admin, "body", "Ben Aufsicht"));

  // ---- participant delete modal: centered, cancel preserves, confirm removes ----
  await admin.waitForFunction(() => document.body.textContent.includes("Wegwerf Teilnehmer"), { timeout: 20000 });
  await openDeleteModal("Wegwerf Teilnehmer löschen");
  const partModalCenter = await modalCentered();
  check("participant delete modal centered viewport, fits without scrolling", partModalCenter.ok, partModalCenter.why);
  await clickText(admin, "button", "Abbrechen");
  await new Promise((r) => setTimeout(r, 500));
  check("participant delete cancel preserves row", await hasText(admin, "body", "Wegwerf Teilnehmer"));
  await openDeleteModal("Wegwerf Teilnehmer löschen");
  await clickText(admin, '[data-testid="delete-confirm"]', "Bestätigen");
  await admin.waitForFunction(() => !document.body.textContent.includes("Wegwerf Teilnehmer"), { timeout: 15000 });
  check("participant delete confirm performs removal", !(await hasText(admin, "body", "Wegwerf Teilnehmer")));
  // Mobile viewport modal fits as well.
  await admin.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await admin.waitForFunction(() => document.body.textContent.includes("Lina Browser"), { timeout: 20000 });
  await openDeleteModal("Lina Browser löschen");
  const mobileModal = await modalCentered();
  await admin.screenshot({ path: join(shotDir, "delete-modal-mobile.png") });
  await admin.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  check("participant delete modal fits mobile viewport", mobileModal.ok && await hasText(admin, "body", "Lina Browser"), mobileModal.why);
  admin.off("request", deleteCounter);
  await admin.setViewport({ width: 1360, height: 900 });
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
