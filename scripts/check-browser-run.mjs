// Focused browser check for the Kartoffellauf feature (puppeteer-core).
// Isolated local file DB + local dev server; never live Turso credentials.
// Covers: Kartoffellauf rename, stopwatch duration boundaries via a controlled
// performance.now test clock, the shared/autosaved error counter (rapid +/-
// clicks, keyboard, pending-PATCH survival), the run preview, the admin
// Laufzeit/Fehler/Ergebniszeit overview, resetting time vs counter, and
// finalize rankings on the effective time.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const dbFile = join(repo, "artifacts", "test", `browser-run-${process.pid}.db`);
const PORT = 4312;
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
      if (/ready|Local.*4312|http:\/\/localhost:4312/i.test(s)) {
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

async function noHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
}

let server = null;
let browser = null;
try {
  mkdirSync(join(repo, "artifacts", "test"), { recursive: true });
  try { rmSync(dbFile, { force: true }); } catch { /* ignore */ }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
  }

  const childEnv = { ...process.env };
  childEnv.TURSO_DATABASE_URL = `file:${dbFile}`;
  delete childEnv.TURSO_AUTH_TOKEN;

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

  // ---- rename: Kartoffellauf everywhere, no Hindernisparcours ----
  await admin.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 30000 });
  const homeText = await admin.evaluate(() => document.body.textContent || "");
  check(
    "homepage uses Kartoffellauf, no Hindernisparcours",
    homeText.includes("Kartoffellauf") && !homeText.includes("Hindernisparcours") && !homeText.includes("Hindernislauf"),
  );

  // ---- admin: start collection, create supervisors ----
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0", timeout: 30000 });
  await admin.waitForFunction(() => document.body.textContent.includes("Spielleitung"), { timeout: 20000 });
  const adminNoHindernis = !(await admin.evaluate(() => document.body.textContent || "").then((t) => t.includes("Hindernis")));
  check("admin page has no Hindernis label", adminNoHindernis);
  if (await hasText(admin, "button", "Erfassung starten")) {
    await clickText(admin, "button", "Erfassung starten");
    await admin.waitForFunction(() => document.body.textContent.includes("Erfassung stoppen"), { timeout: 15000 });
  }
  await admin.type('input[aria-label="Name der neuen Aufsicht"]', "Anna Aufsicht");
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForFunction(() => document.body.textContent.includes("Einladung: Anna Aufsicht"), { timeout: 15000 });
  await admin.keyboard.press("Escape");
  await admin.type('input[aria-label="Name der neuen Aufsicht"]', "Ben Aufsicht");
  await clickText(admin, "button", "Aufsicht anlegen");
  await admin.waitForFunction(() => document.body.textContent.includes("Einladung: Ben Aufsicht"), { timeout: 15000 });
  await admin.keyboard.press("Escape");
  const st = await adminFetch(admin, "/api/gamemaster/state");
  const supAId = st.body.supervisors.find((s) => s.name === "Anna Aufsicht")?.id;
  const supBId = st.body.supervisors.find((s) => s.name === "Ben Aufsicht")?.id;
  const invA = await adminFetch(admin, `/api/gamemaster/supervisors/${supAId}/invite`);
  const invB = await adminFetch(admin, `/api/gamemaster/supervisors/${supBId}/invite`);
  const tokenA = invA.body.token;
  const tokenB = invB.body.token;
  check("supervisors + tokens ready (not logged)", Boolean(tokenA && tokenB && supAId && supBId));

  // ---- supervisor A: create draft and open editor ----
  await supA.goto(`${BASE}/aufsicht/${tokenA}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supA.waitForFunction(() => document.body.textContent.includes("Aufsicht: Anna Aufsicht"), { timeout: 20000 });
  await supA.click('[data-testid="new-participant"]');
  await supA.waitForSelector('[data-testid="create-form"]');
  await supA.type("#ko-new-name", "Runa Lauf");
  await supA.click('[data-testid="age-option-up_to_14"]');
  await supA.click('[data-testid="start-participant"]');
  await supA.waitForSelector('[data-testid="field-golf"]', { timeout: 15000 });

  const supNoHindernis = !(await supA.evaluate(() => document.body.textContent || "").then((t) => t.includes("Hindernis")));
  const kartoffelAria = await supA.$eval('[data-testid="field-obstacle"]', (el) => el.getAttribute("aria-label"));
  check(
    "supervisor editor labels Kartoffellauf with seconds aria label",
    supNoHindernis && kartoffelAria === "Zeit Kartoffellauf in Sekunden",
    `aria="${kartoffelAria}"`,
  );

  // ---- stopwatch duration boundaries via controlled performance.now ----
  // Frozen manual clock: elapsed = fake now - start stamp, so exact values.
  await supA.evaluate(() => {
    window.__origPerfNow = performance.now.bind(performance);
    window.__fakeNow = 0;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => window.__fakeNow,
    });
  });
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-obstacle"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Start")).click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await supA.evaluate(() => { window.__fakeNow = 61500; });
  await new Promise((r) => setTimeout(r, 400));
  const minuteBadge = await supA.$eval('[data-testid="stopwatch-obstacle"] .ko-badge', (el) => el.textContent);
  await supA.evaluate(() => { window.__fakeNow = 3723400; }); // 1 h 02 min 03,4 s
  await new Promise((r) => setTimeout(r, 400));
  const hourBadge = await supA.$eval('[data-testid="stopwatch-obstacle"] .ko-badge', (el) => el.textContent);
  check(
    "stopwatch hides leading units at minute boundary (no empty 0 h / 0 min)",
    minuteBadge === "1 min 01,5 s",
    `badge="${minuteBadge}"`,
  );
  check(
    "stopwatch shows hours/minutes/seconds/tenths with inner zero fields",
    hourBadge === "1 h 02 min 03,4 s" && !hourBadge.startsWith("0 "),
    `badge="${hourBadge}"`,
  );
  // Pause persists rounded tenths; reset clears the field and stays at 0,0 s.
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-obstacle"]');
    const pause = [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Pause"));
    pause.click();
    const reset = [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Zurücksetzen"));
    reset.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const resetField = await supA.$eval('[data-testid="field-obstacle"]', (el) => el.value);
  const resetBadge = await supA.$eval('[data-testid="stopwatch-obstacle"] .ko-badge', (el) => el.textContent);
  check(
    "stopwatch reset empties field and shows 0,0 s (no persisted fake time)",
    resetField === "" && resetBadge === "0,0 s",
    `field="${resetField}" badge="${resetBadge}"`,
  );
  await supA.evaluate(() => {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: window.__origPerfNow,
    });
  });

  // ---- error counter: default 0, rapid +/- via latest ref, keyboard input ----
  const defaultErrors = await supA.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  check("run error counter defaults to 0", defaultErrors === "0", `got "${defaultErrors}"`);
  await supA.evaluate(() => {
    const plus = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fehler erhöhen");
    plus.click(); plus.click(); plus.click();
  });
  const rapidErrors = await supA.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  check("rapid same-tick + clicks accumulate from latest ref", rapidErrors === "3", `got "${rapidErrors}"`);
  await supA.evaluate(() => {
    const minus = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fehler verringern");
    minus.click();
  });
  const afterMinus = await supA.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  check("error counter minus decrements", afterMinus === "2", `got "${afterMinus}"`);
  await typeInto(supA, "field-run-errors", "2");
  await supA.evaluate(() => document.querySelector('[data-testid="field-run-errors"]').blur());

  // ---- preview: no result while raw blank, then Laufzeit - Fehler*3s ----
  const previewBlank = await supA.evaluate(() => !document.querySelector('[data-testid="run-preview-value"]'));
  check("no run result preview while time is blank", previewBlank);
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await typeInto(supA, "field-obstacle", "12,3");
  await supA.evaluate(() => document.querySelector('[data-testid="field-obstacle"]').blur());
  await new Promise((r) => setTimeout(r, 400));
  const previewValue = await supA.$eval('[data-testid="run-preview-value"]', (el) => el.textContent).catch(() => null);
  check(
    "preview shows effective time 12,3 s - 2*3 s = 6,3 s",
    previewValue === "6,3 s",
    `preview="${previewValue}"`,
  );

  // ---- resetting the stopwatch empties time, never the counter ----
  await supA.evaluate(() => {
    const box = document.querySelector('[data-testid="stopwatch-obstacle"]');
    [...box.querySelectorAll("button")].find((b) => b.textContent.includes("Zurücksetzen")).click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const afterResetTime = await supA.$eval('[data-testid="field-obstacle"]', (el) => el.value);
  const afterResetErrors = await supA.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  const previewGone = await supA.evaluate(() => !document.querySelector('[data-testid="run-preview-value"]'));
  check(
    "reset clears time only, counter stays 2, preview hidden",
    afterResetTime === "" && afterResetErrors === "2" && previewGone,
    `time="${afterResetTime}" errors="${afterResetErrors}"`,
  );
  await typeInto(supA, "field-obstacle", "12,3");
  await supA.evaluate(() => document.querySelector('[data-testid="field-obstacle"]').blur());

  // ---- pending-PATCH survival for the counter ----
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  const netCtl = { holdPatch: false, heldPatch: [] };
  const netHandler = async (req) => {
    try {
      const url = new URL(req.url());
      if (req.method() === "PATCH" && url.pathname.startsWith("/api/participants/")) {
        if (netCtl.holdPatch) {
          netCtl.heldPatch.push(req);
          return;
        }
      }
    } catch { /* continue */ }
    await req.continue().catch(() => {});
  };
  await supA.setRequestInterception(true);
  supA.on("request", netHandler);
  async function waitForHeldPatch(timeout = 15000) {
    const start = Date.now();
    while (netCtl.heldPatch.length === 0) {
      if (Date.now() - start > timeout) throw new Error("timed out waiting for held PATCH");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  netCtl.holdPatch = true;
  await supA.evaluate(() => {
    const plus = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fehler erhöhen");
    plus.click();
  });
  await waitForHeldPatch();
  await supA.evaluate(() => {
    const plus = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fehler erhöhen");
    plus.click();
  });
  netCtl.holdPatch = false;
  for (const req of netCtl.heldPatch.splice(0)) await req.continue().catch(() => {});
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3600)); // let a full 3s poll pass
  const survivedErrors = await supA.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  const stAfterPending = await adminFetch(admin, "/api/gamemaster/state");
  const pendingPid = stAfterPending.body.participants.find((p) => p.name === "Runa Lauf")?.id;
  const serverErrors = stAfterPending.body.participants.find((p) => p.name === "Runa Lauf")?.runErrors;
  check(
    "rapid +/- during pending PATCH survives save and poll",
    survivedErrors === "4" && serverErrors === 4,
    `field="${survivedErrors}" server=${serverErrors}`,
  );
  supA.off("request", netHandler);
  await supA.setRequestInterception(false).catch(() => {});
  // Settle on the final counter value used for ranking.
  await typeInto(supA, "field-run-errors", "2");
  await supA.evaluate(() => document.querySelector('[data-testid="field-run-errors"]').blur());

  // ---- remaining disciplines + save ----
  await typeInto(supA, "field-golf", "3");
  await supA.evaluate(() => document.querySelector('[data-testid="field-golf"]').blur());
  await typeInto(supA, "field-throwing", "2");
  await supA.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());
  await typeInto(supA, "field-peeling", "45,0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-peeling"]').blur());
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  const savedStatus = await supA.$eval('[data-testid="save-status"]', (el) => el.textContent);
  check("Runa values autosaved including error count", savedStatus.includes("Gespeichert"), savedStatus.trim());

  // ---- second supervisor sees the shared counter ----
  await supB.goto(`${BASE}/aufsicht/${tokenB}`, { waitUntil: "networkidle0", timeout: 30000 });
  await supB.waitForFunction(() => document.body.textContent.includes("Runa Lauf"), { timeout: 20000 });
  await supB.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Runa Lauf"));
    if (btn) btn.click();
  });
  await supB.waitForSelector('[data-testid="field-run-errors"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));
  const supBErrors = await supB.$eval('[data-testid="field-run-errors"]', (el) => el.value);
  const supBTime = await supB.$eval('[data-testid="field-obstacle"]', (el) => el.value);
  const supBAttr = await supB.$eval('[data-testid="attribution-obstacle"]', (el) => el.textContent);
  check(
    "second supervisor sees saved counter and time",
    supBErrors === "2" && supBTime === "12,3" && supBAttr.includes("Anna Aufsicht"),
    `errors="${supBErrors}" time="${supBTime}" attr="${supBAttr.trim().slice(0, 30)}"`,
  );
  // B changes only the counter: attribution moves to Ben, time untouched.
  await typeInto(supB, "field-run-errors", "5");
  await supB.evaluate(() => document.querySelector('[data-testid="field-run-errors"]').blur());
  await supB.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3600));
  await supA.bringToFront?.();
  const attrObstAfter = await supA.$eval('[data-testid="attribution-obstacle"]', (el) => el.textContent);
  const obstAfter = await supA.$eval('[data-testid="field-obstacle"]', (el) => el.value);
  check(
    "count-only change by other supervisor reattributes run only",
    attrObstAfter.includes("Ben Aufsicht") && obstAfter === "12,3",
    `attr="${attrObstAfter.trim().slice(0, 30)}" time="${obstAfter}"`,
  );

  // ---- settle Runa back to errors 2 and finalize ----
  await typeInto(supA, "field-run-errors", "2");
  await supA.evaluate(() => document.querySelector('[data-testid="field-run-errors"]').blur());
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await supA.waitForFunction(() => {
    const b = document.querySelector('[data-testid="finalize"]');
    return b && !b.disabled;
  }, { timeout: 20000 });
  await supA.click('[data-testid="finalize"]');
  await supA.waitForFunction(() => !document.body.textContent.includes("Runa Lauf"), { timeout: 20000 });

  // ---- second participant Taro (no errors) for ranking comparison ----
  // With 3 s per error, Runa's effective 6,3 s still beats Taro's adjusted
  // raw 10,0 s; Taro's hits lowered so the error-adjusted order stays the
  // only reason Runa ranks ahead (Runa sum 5 vs Taro sum 7).
  await supA.click('[data-testid="new-participant"]');
  await supA.waitForSelector('[data-testid="create-form"]');
  await supA.type("#ko-new-name", "Taro Lauf");
  await supA.click('[data-testid="age-option-up_to_14"]');
  await supA.click('[data-testid="start-participant"]');
  await supA.waitForSelector('[data-testid="field-golf"]', { timeout: 15000 });
  await typeInto(supA, "field-golf", "5");
  await supA.evaluate(() => document.querySelector('[data-testid="field-golf"]').blur());
  await typeInto(supA, "field-obstacle", "10,0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-obstacle"]').blur());
  await typeInto(supA, "field-throwing", "0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());
  await typeInto(supA, "field-peeling", "30,0");
  await supA.evaluate(() => document.querySelector('[data-testid="field-peeling"]').blur());
  await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
  await supA.waitForFunction(() => {
    const b = document.querySelector('[data-testid="finalize"]');
    return b && !b.disabled;
  }, { timeout: 20000 });
  await supA.click('[data-testid="finalize"]');
  await supA.waitForFunction(() => !document.body.textContent.includes("Taro Lauf"), { timeout: 20000 });

  // ---- equal-sum tie-break fixture (over_14): unique winner by more wins ----
  // Ella and Fynn tie on sum 6 (golf shared first, Ella wins obstacle+peeling,
  // Fynn wins throwing); Ella wins 3 disciplines vs Fynn's 2 -> Ella is the
  // unique winner; Gero (sum 11) is clearly 3rd.
  async function createAndFinalizeTie(name, golf, obstacle, throwing, peeling) {
    await supA.click('[data-testid="new-participant"]');
    await supA.waitForSelector('[data-testid="create-form"]');
    await supA.type("#ko-new-name", name);
    await supA.click('[data-testid="age-option-over_14"]');
    await supA.click('[data-testid="start-participant"]');
    await supA.waitForSelector('[data-testid="field-golf"]', { timeout: 15000 });
    await typeInto(supA, "field-golf", golf);
    await supA.evaluate(() => document.querySelector('[data-testid="field-golf"]').blur());
    await typeInto(supA, "field-obstacle", obstacle);
    await supA.evaluate(() => document.querySelector('[data-testid="field-obstacle"]').blur());
    await typeInto(supA, "field-throwing", throwing);
    await supA.evaluate(() => document.querySelector('[data-testid="field-throwing"]').blur());
    await typeInto(supA, "field-peeling", peeling);
    await supA.evaluate(() => document.querySelector('[data-testid="field-peeling"]').blur());
    await supA.waitForFunction(() => document.body.textContent.includes("Gespeichert"), { timeout: 20000 }).catch(() => {});
    await supA.waitForFunction(() => {
      const b = document.querySelector('[data-testid="finalize"]');
      return b && !b.disabled;
    }, { timeout: 20000 });
    await supA.click('[data-testid="finalize"]');
    await supA.waitForFunction(
      (nm) => !document.body.textContent.includes(nm),
      { timeout: 20000 },
      name,
    );
  }
  await createAndFinalizeTie("Ella Tie", "2", "4,0", "1", "40,0");
  await createAndFinalizeTie("Fynn Tie", "2", "5,0", "5", "50,0");
  await createAndFinalizeTie("Gero Tie", "5", "6,0", "3", "60,0");

  // ---- admin overview cell + leaders on effective time ----
  await admin.bringToFront?.();
  await admin.waitForFunction(() => document.body.textContent.includes("Platzsumme"), { timeout: 25000 });
  // Wait for both finalized participants to reach the admin standings (poll race).
  await admin.waitForFunction(() => {
    const lis = [...document.querySelectorAll(".ko-soft ol li")];
    return lis.some((li) => (li.textContent || "").includes("Taro Lauf")) &&
      lis.some((li) => (li.textContent || "").includes("Runa Lauf"));
  }, { timeout: 25000 });
  check("admin table header shows Kartoffellauf", await hasText(admin, "th", "Kartoffellauf"));
  const runaCell = await admin.evaluate(() => {
    const rows = [...document.querySelectorAll(".ko-table tbody tr")];
    const row = rows.find((r) => (r.textContent || "").includes("Runa Lauf"));
    if (!row) return null;
    const tds = [...row.querySelectorAll("td")];
    return tds[3]?.textContent || "";
  });
  check(
    "admin overview labels Laufzeit/Fehler/Ergebniszeit",
    runaCell !== null && runaCell.includes("Laufzeit:") && runaCell.includes("Fehler:") &&
      runaCell.includes("Ergebniszeit:") && runaCell.includes("12,3 s") && runaCell.includes("6,3 s"),
    runaCell?.replace(/\s+/g, " ").slice(0, 80),
  );
  const leaderLine = await admin.evaluate(() => {
    const p = [...document.querySelectorAll("p")].find(
      (e) => /^Kartoffellauf: .+\(\d+,\d s\)/.test((e.textContent || "").trim()),
    );
    return p ? p.textContent : "";
  });
  check(
    "leaders rank Runa first on effective 6,3 s despite slower raw 12,3 s",
    leaderLine.includes("Runa Lauf (6,3 s)"),
    leaderLine.replace(/\s+/g, " ").slice(0, 80),
  );
  const noDoubleSub = !leaderLine.includes("12,3 s (6,3") && !leaderLine.includes("-2");
  check("leader effective time is not double-subtracted", noDoubleSub);
  const overallOrder = await admin.evaluate(() => {
    const lis = [...document.querySelectorAll(".ko-soft ol li")];
    return lis.slice(0, 4).map((li) => (li.textContent || "").replace(/\s+/g, " ").trim());
  });
  check(
    "overall standings order reflects effective times (Runa Platz 1, Taro Platz 2)",
    (overallOrder[0] || "").includes("Platz 1: Runa Lauf") && (overallOrder[1] || "").includes("Platz 2: Taro Lauf"),
    overallOrder.join(" | "),
  );

  // ---- equal-sum tie-break: unique winner by more discipline wins ----
  await admin.waitForFunction(() => {
    const t = document.body.textContent;
    return t.includes("Ella Tie") && t.includes("Fynn Tie") && t.includes("Gero Tie");
  }, { timeout: 25000 });
  const tieResults = await admin.evaluate(() => {
    const block = [...document.querySelectorAll(".ko-soft")].find(
      (b) => (b.textContent || "").includes("Ella Tie"),
    );
    if (!block) return null;
    const ol = block.querySelector("ol");
    const lis = [...(ol?.querySelectorAll("li") ?? [])].map(
      (li) => (li.textContent || "").replace(/\s+/g, " ").trim(),
    );
    const winnerP = [...block.querySelectorAll("p")].find((p) =>
      (p.textContent || "").includes("Gesamt:"),
    );
    return {
      winner: winnerP ? winnerP.textContent.replace(/\s+/g, " ").trim() : "",
      lis,
    };
  });
  check(
    "equal-sum tie-break picks the unique winner by more discipline wins",
    tieResults !== null &&
      tieResults.winner.includes("Ella Tie") &&
      !tieResults.winner.includes("Fynn Tie") &&
      (tieResults.lis[0] || "").includes("Platz 1: Ella Tie") &&
      (tieResults.lis[1] || "").includes("Platz 2: Fynn Tie") &&
      (tieResults.lis[2] || "").includes("Platz 3: Gero Tie"),
    JSON.stringify(tieResults),
  );

  // ---- mobile no horizontal overflow ----
  await admin.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await admin.goto(`${BASE}/gamemaster`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1200));
  check("mobile no horizontal overflow with run details (gamemaster)", await noHorizontalOverflow(admin));
} catch (e) {
  console.error("BROWSER RUN CHECK ERROR:", e instanceof Error ? e.message : e);
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

const failedTotal = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedTotal.length}/${results.length} run-feature browser checks passed.`);
if (failedTotal.length > 0) process.exitCode = 1;