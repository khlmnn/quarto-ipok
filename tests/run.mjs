// Tests for ipok: renders tests/site with the current extension, serves it
// with a mock Progress API, and drives it in headless Chromium. MSAL is
// replaced by a fake for signed-in runs. Also checks the filter's build errors.
//
//   cd tests && npm install && npm test

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "_extensions", "ipok");
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const COURSE = "ipok-test";
const ACCOUNT = "11111111-2222-3333-4444-555555555555";

let failures = 0;
let passes = 0;
function ok(cond, name, detail = "") {
  if (cond) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// ---- Build ---------------------------------------------------------------

function useExtension(site) {
  rmSync(join(site, "_extensions", "ipok"), { recursive: true, force: true });
  mkdirSync(join(site, "_extensions"), { recursive: true });
  cpSync(ext, join(site, "_extensions", "ipok"), { recursive: true });
}

function render(site) {
  useExtension(site);
  return spawnSync("quarto", ["render"], { cwd: site, encoding: "utf8" });
}

// ---- Filter errors -------------------------------------------------------

const SITE_YML = readFileSync(join(here, "site", "_quarto.yml"), "utf8");
const page = (body) => `---\ntitle: Bad\nmodule-id: m\nsection-id: s\n---\n\n${body}\n`;
const q = (attrs, text, variants) => `::: {.question ${attrs}}\n${text}\n\n\`\`\`{.variants}\n${variants}\n\`\`\`\n:::`;

const BAD = [
  ["no type", q(`id="a"`, "x", `[{"id":"v","answer":"y"}]`), "needs type="],
  ["bad JSON", q(`id="a" type="text"`, "x", `[{"id":"v",}]`), "is not valid JSON"],
  ["empty table", q(`id="a" type="text"`, "x", `[]`), "non-empty JSON array"],
  ["missing placeholder value", q(`id="a" type="text"`, "{{w}}", `[{"id":"v","answer":"y"}]`), "has no value for {{w}}"],
  ["unused field", q(`id="a" type="text"`, "x", `[{"id":"v","w":1,"answer":"y"}]`), "is not used as a placeholder"],
  ["number answer not a number", q(`id="a" type="number"`, "x", `[{"id":"v","answer":"5"}]`), "must be a number"],
  ["mcq answer not an option", q(`id="a" type="mcq"`, "x", `[{"id":"v","options":["1","2"],"answer":"3"}]`), "must be one of the options"],
  ["duplicate variant id", q(`id="a" type="text"`, "x", `[{"id":"v","answer":"y"},{"id":"v","answer":"z"}]`), "variant id 'v' appears twice"],
  ["id clash with exercise", q(`id="a" type="text"`, "x", `[{"id":"v","answer":"y"}]`) + `\n\n::: {.exercise id="a"}\n:::`, "duplicate exercise or question id 'a'"],
  ["decimals on text", q(`id="a" type="text" decimals="2"`, "x", `[{"id":"v","answer":"y"}]`), "only allowed in number questions"],
  ["missing file", `::: {.question id="a" type="text" variants="nope.json"}\nx\n:::`, "cannot read variants file nope.json"],
];

function testFilterErrors() {
  console.log("filter errors");
  const site = join(here, "bad");
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "_quarto.yml"), SITE_YML);
  for (const [name, body, message] of BAD) {
    writeFileSync(join(site, "index.qmd"), page(body));
    const r = render(site);
    const out = r.stdout + r.stderr;
    ok(r.status !== 0 && out.includes(message), name, r.status === 0 ? "rendered without error" : out.split("\n").find((l) => l.includes("[ipok]")) || "");
  }
  rmSync(site, { recursive: true, force: true });
}

// ---- Mock API and static server -----------------------------------------

const store = new Map(); // "module/section/exercise" -> {exerciseId, exerciseData, completed}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function serve(root) {
  return createServer((req, res) => {
    const url = new URL(req.url, BASE);
    if (url.pathname.startsWith("/mock-api/")) return mockApi(req, res, url);
    let path = join(root, decodeURIComponent(url.pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  }).listen(PORT);
}

function mockApi(req, res, url) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    const parts = url.pathname.replace("/mock-api/api/Progress/", "").split("/").map(decodeURIComponent);
    // [ci, "modules", m, "sections", s, ("exercises", e)]
    if (parts[0] !== COURSE) return send(400, { error: "wrong course instance" });
    if (req.method === "PUT" && parts.length === 1) {
      const p = JSON.parse(body);
      store.set(`${p.moduleId}/${p.sectionId}/${p.exerciseId}`, { exerciseId: p.exerciseId, exerciseData: p.exerciseData, completed: new Date().toISOString() });
      return send(200);
    }
    if (req.method === "GET" && parts.length === 5) {
      const prefix = `${parts[2]}/${parts[4]}/`;
      return send(200, { sectionId: parts[4], exercises: [...store].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v) });
    }
    if (req.method === "DELETE" && parts.length === 7) {
      store.delete(`${parts[2]}/${parts[4]}/${parts[6]}`);
      return send(200);
    }
    send(404);
  });
}

const record = (module, section, id) => {
  const r = store.get(`${module}/${section}/${id}`);
  return r ? JSON.parse(r.exerciseData) : undefined;
};

// The record once `pred` holds for it (saves are asynchronous), or after 2 s.
async function settled(module, section, id, pred) {
  for (let i = 0; i < 40 && !pred(record(module, section, id)); i++) await new Promise((r) => setTimeout(r, 50));
  return record(module, section, id);
}

// A stand-in for msal-browser: signed in as ACCOUNT with the given roles.
function fakeMsal(roles) {
  const payload = Buffer.from(JSON.stringify({ roles })).toString("base64url");
  return `
    var msal = (() => {
      const account = { localAccountId: ${JSON.stringify(ACCOUNT)}, homeAccountId: "h", username: "test@example.org", name: "Test Student" };
      class InteractionRequiredAuthError extends Error {}
      class PublicClientApplication {
        async initialize() {}
        async handleRedirectPromise() { return null; }
        getActiveAccount() { return account; }
        getAllAccounts() { return [account]; }
        setActiveAccount() {}
        async acquireTokenSilent() { return { accessToken: "x.${payload}.y" }; }
        loginRedirect() { return Promise.resolve(); }
        logoutRedirect() {}
        acquireTokenRedirect() { return Promise.resolve(); }
      }
      return { PublicClientApplication, InteractionRequiredAuthError };
    })();`;
}

// ---- Browser helpers -------------------------------------------------------

async function openPage(browser, { roles = null, query = "", seed = null } = {}) {
  const context = await browser.newContext();
  if (roles) {
    await context.route("**/msal-browser.min.js", (route) => route.fulfill({ contentType: "text/javascript", body: fakeMsal(roles) }));
  }
  if (seed !== null) {
    await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [`ipok-seed:${COURSE}`, String(seed)]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${BASE}/questions.html${query}`);
  await page.waitForFunction(() => [...document.querySelectorAll(".question .ipok-status")].every((s) => !/Laddar/.test(s.textContent)));
  return { page, context, errors };
}

const Q = (page, id) => page.locator(`.question[data-question-id="${id}"]`);
const status = (page, id) => Q(page, id).locator(".ipok-buttons .ipok-status").first().textContent();
const debugLine = (page, id) => Q(page, id).locator(".ipok-debug-line").textContent();
// "variant v02 (1/3) · försök 0 · löst – · svar 9" -> {variant, answer, ...}
async function debugInfo(page, id) {
  const line = await debugLine(page, id);
  const m = line.match(/variant (\S+) \((\d+)\/(\d+)\) · försök (\d+) · löst (\S) · svar (.*?)( · |$)/);
  return { variant: m[1], position: +m[2], attempt: +m[4], solved: m[5] === "✓", answer: m[6] };
}

async function answer(page, id, value) {
  const box = Q(page, id);
  if (await box.locator("input[type=radio]").count()) {
    const values = await box.locator("input[type=radio]").evaluateAll((xs) => xs.map((x) => x.value));
    await box.locator("input[type=radio]").nth(values.indexOf(value)).check();
  } else {
    await box.locator("input.ipok-answer").fill(value);
  }
  await box.getByRole("button", { name: "Svara" }).click();
}

// ---- Tests -----------------------------------------------------------------

async function testSignedOut(browser) {
  console.log("signed out");
  const { page, context, errors } = await openPage(browser, { seed: 42 });
  const text = await page.locator("main").textContent();
  ok(!text.includes("{{"), "no unfilled placeholders");
  ok(await Q(page, "q-number").locator(".ipok-question-note").isVisible(), "sign-in note is shown");
  ok(!(await page.locator(".ipok-debug-panel").count()), "no debug panel without ?ipok-debug");
  await page.waitForFunction(() => document.querySelector('[data-question-id="q-number"] mjx-container'), null, { timeout: 15000 })
    .then(() => ok(true, "math in the question text is typeset"), () => ok(false, "math in the question text is typeset"));
  const shown = await Q(page, "q-text").locator(".ipok-question-body").textContent();
  ok(/katt|hund/.test(shown), "text question shows a variant", shown);

  // Number parsing without the debug panel: q-decimals has one variant (x = 1).
  await answer(page, "q-decimals", "abc");
  eq(await status(page, "q-decimals"), "Skriv ett tal, till exempel 3,5.", "non-number gives a hint");
  await answer(page, "q-decimals", "0,34");
  eq(await status(page, "q-decimals"), "Fel, försök igen.", "wrong number");
  eq(await Q(page, "q-decimals").locator("input.ipok-answer").inputValue(), "0,34", "wrong answer stays in the box");
  await answer(page, "q-decimals", " 0,333 ");
  eq(await status(page, "q-decimals"), "Rätt!", "decimals=2 accepts 0,333 for 0.3333333");
  ok(await Q(page, "q-decimals").locator("input.ipok-answer").isDisabled(), "solved question is read-only");

  await answer(page, "q-case", "  ELSA ");
  eq(await status(page, "q-case"), "Rätt!", "ignore-case and whitespace");
  await page.reload();
  await page.waitForSelector('[data-question-id="q-case"] input.ipok-answer');
  eq(await status(page, "q-case"), "", "signed out: nothing is kept after reload");
  ok(errors.length === 0, "no console errors", errors.join("; "));
  await context.close();
}

async function testDebugLocal(browser) {
  console.log("debug panel on localhost, signed out");
  const { page, context, errors } = await openPage(browser, { seed: 42, query: "?ipok-debug" });
  ok(await page.locator(".ipok-debug-panel").isVisible(), "debug panel is shown");
  eq(await page.locator(".ipok-debug-panel input[type=text]").inputValue(), "42", "panel shows the local seed");

  // Exact numbers, comma and period.
  let info = await debugInfo(page, "q-number");
  await answer(page, "q-number", String(Number(info.answer) + 1));
  eq(await status(page, "q-number"), "Fel, försök igen.", "wrong number answer");
  eq((await debugInfo(page, "q-number")).variant, info.variant, "number question keeps its variant after a wrong answer");
  eq((await debugInfo(page, "q-number")).attempt, 1, "attempt counted");
  await answer(page, "q-number", info.answer.replace(".", ","));
  eq(await status(page, "q-number"), "Rätt!", `number answer ${info.answer} accepted with comma`);

  // Text.
  info = await debugInfo(page, "q-text");
  await answer(page, "q-text", ` ${info.answer.toUpperCase()} `);
  eq(await status(page, "q-text"), "Fel, försök igen.", "text is case-sensitive by default");
  await answer(page, "q-text", ` ${info.answer} `);
  eq(await status(page, "q-text"), "Rätt!", "text answer with surrounding spaces");

  // MCQ: a wrong answer, then a new variant.
  info = await debugInfo(page, "q-mcq");
  const options = await Q(page, "q-mcq").locator("input[type=radio]").evaluateAll((xs) => xs.map((x) => x.value));
  const wrong = options.find((o) => o !== info.answer);
  await answer(page, "q-mcq", wrong);
  eq(await status(page, "q-mcq"), "Fel.", "wrong mcq answer");
  ok(await Q(page, "q-mcq").getByRole("button", { name: "Ny fråga" }).isVisible(), "'Ny fråga' is shown");
  ok(await Q(page, "q-mcq").locator("input[type=radio]").first().isDisabled(), "options locked after a wrong answer");
  await Q(page, "q-mcq").getByRole("button", { name: "Ny fråga" }).click();
  const next = await debugInfo(page, "q-mcq");
  ok(next.variant !== info.variant && next.position === info.position + 1, "next mcq variant in the student's order", JSON.stringify([info, next]));
  await answer(page, "q-mcq", next.answer);
  eq(await status(page, "q-mcq"), "Rätt!", "right mcq answer");

  // The seed decides the variants; the same seed gives the same ones.
  const variantsFor = async (seed) => {
    await page.locator(".ipok-debug-panel input[type=text]").fill(String(seed));
    await page.locator(".ipok-debug-panel").getByRole("button", { name: "Spara" }).click();
    return (await debugInfo(page, "q-file")).variant;
  };
  const seen = new Set();
  for (let s = 1; s <= 12; s++) seen.add(await variantsFor(s));
  ok(seen.size >= 5, "different seeds give different variants", [...seen].join(","));
  eq(await variantsFor(7), await variantsFor(7), "the same seed gives the same variant");
  eq(await page.evaluate((k) => localStorage.getItem(k), `ipok-seed:${COURSE}`), "7", "Spara writes the local seed");

  // Next variant on a number question is a local offset only.
  const before = await debugInfo(page, "q-file");
  await Q(page, "q-file").getByRole("button", { name: "Nästa variant" }).click();
  const after = await debugInfo(page, "q-file");
  eq(after.position, before.position % 12 + 1, "'Nästa variant' steps through a number question's variants");
  ok((await debugLine(page, "q-file")).includes("sparas inte"), "the offset is marked as not saved");

  await page.locator(".ipok-debug-panel").getByText("Visa alla varianter").click();
  eq(await Q(page, "q-file").locator(".ipok-debug-table tbody tr").count(), 12, "'Visa alla varianter' lists the table");
  ok(errors.length === 0, "no console errors", errors.join("; "));
  await context.close();
}

function derivedSeed() {
  return createHash("sha256").update(`${COURSE}:${ACCOUNT}`).digest().readUInt32BE(0);
}

async function testSignedIn(browser) {
  console.log("signed in, student");
  store.clear();
  let { page, context, errors } = await openPage(browser, { roles: ["Student"], query: "?ipok-debug" });
  eq(record("_ipok", "_ipok", "seed"), { seed: derivedSeed() }, "seed record created from the account");
  ok(!(await page.locator(".ipok-debug-panel").count()), "no debug panel without the Teacher role");
  ok(!(await Q(page, "q-number").locator(".ipok-question-note").isVisible()), "no sign-in note");
  eq(await page.locator('.exercise[data-exercise-id="ex-plain"] .ipok-status').textContent(), "nothing saved yet", "exercise widget still loads");

  await answer(page, "q-decimals", "1");
  eq(await settled("test-module", "questions", "q-decimals", (r) => r),
    { attempt: 1, variant: "v01", solved: false, answers: [{ variant: "v01", answer: "1", correct: false }] }, "wrong answer saved");
  await answer(page, "q-decimals", "0.33");
  const r = await settled("test-module", "questions", "q-decimals", (r) => r?.solved);
  ok(r.solved && r.attempt === 1 && r.answers.length === 2, "right answer saved", JSON.stringify(r));

  const mcqOptions = await Q(page, "q-mcq").locator("input[type=radio]").evaluateAll((xs) => xs.map((x) => x.value));
  const mcqText = await Q(page, "q-mcq").locator(".ipok-question-input").textContent();
  // No debug panel for students: take the right option from the known table.
  const answers = { "1|2|3": "3", "4|6|5": "6" };
  const key = [...mcqOptions].sort().join("|");
  const right = answers[key] ?? "\\(\\frac{1}{2}\\)";
  await answer(page, "q-mcq", mcqOptions.find((o) => o !== right));
  eq((await settled("test-module", "questions", "q-mcq", (r) => r))?.attempt, 1, "wrong mcq answer saved as attempt 1");
  await context.close();

  ({ page, context, errors } = await openPage(browser, { roles: ["Student"] }));
  eq(await status(page, "q-decimals"), "Rätt!", "solved question restored after reload");
  eq(await Q(page, "q-decimals").locator("input.ipok-answer").inputValue(), "0.33", "with the student's answer");
  ok(await Q(page, "q-mcq").locator(".ipok-question-input").textContent() !== mcqText, "after reload, the mcq shows the next variant");
  eq(await status(page, "q-mcq"), "", "and can be answered");
  ok(errors.length === 0, "no console errors", errors.join("; "));
  await context.close();
}

async function testTeacherDebug(browser) {
  console.log("signed in, teacher debug panel");
  store.clear();
  const { page, context, errors } = await openPage(browser, { roles: ["Teacher"], query: "?ipok-debug" });
  const panel = page.locator(".ipok-debug-panel");
  ok(await panel.isVisible(), "debug panel for the Teacher role");
  eq(await panel.locator("input[type=text]").inputValue(), String(derivedSeed()), "panel shows the stored seed");

  await panel.locator("input[type=text]").fill("12345");
  await panel.getByRole("button", { name: "Spara" }).click();
  await page.waitForFunction(() => document.querySelector(".ipok-debug-panel input").value === "12345");
  eq(await settled("_ipok", "_ipok", "seed", (r) => r?.seed === 12345), { seed: 12345 }, "Spara overwrites the seed record");

  store.set("_ipok/_ipok/seed", { exerciseId: "seed", exerciseData: JSON.stringify({ seed: 999 }), completed: "" });
  await panel.getByRole("button", { name: "Läs" }).click();
  await page.waitForFunction(() => document.querySelector(".ipok-debug-panel input").value === "999");
  ok(true, "Läs reads the seed record");

  await panel.getByRole("button", { name: "Återställ härledd" }).click();
  await page.waitForFunction((s) => document.querySelector(".ipok-debug-panel input").value === s, String(derivedSeed()));
  eq(await settled("_ipok", "_ipok", "seed", (r) => r?.seed === derivedSeed()), { seed: derivedSeed() }, "Återställ härledd writes the derived seed");

  const before = await debugInfo(page, "q-mcq");
  await Q(page, "q-mcq").getByRole("button", { name: "Nästa variant" }).click();
  const after = await debugInfo(page, "q-mcq");
  eq([after.attempt, after.position], [1, before.position % 3 + 1], "'Nästa variant' on mcq is a real attempt");
  eq((await settled("test-module", "questions", "q-mcq", (r) => r))?.attempt, 1, "and is saved");

  await answer(page, "q-mcq", after.answer);
  eq(await status(page, "q-mcq"), "Rätt!", "solve mcq");
  await Q(page, "q-mcq").getByRole("button", { name: "Återställ" }).click();
  eq(await settled("test-module", "questions", "q-mcq", (r) => !r), undefined, "Återställ deletes the record");
  eq((await debugInfo(page, "q-mcq")).attempt, 0, "and resets the question");
  ok(errors.length === 0, "no console errors", errors.join("; "));
  await context.close();
}

// ---- Main --------------------------------------------------------------------

const only = process.argv[2];
if (!only || only === "errors") testFilterErrors();
if (!only || only !== "errors") {
  console.log("rendering tests/site");
  const r = render(join(here, "site"));
  if (r.status !== 0) { console.log(r.stdout + r.stderr); process.exit(1); }
  const server = serve(join(here, "site", "_site"));
  const browser = await chromium.launch();
  try {
    await testSignedOut(browser);
    await testDebugLocal(browser);
    await testSignedIn(browser);
    await testTeacherDebug(browser);
  } finally {
    await browser.close();
    server.close();
  }
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
