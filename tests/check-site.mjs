// Checks the questions of a rendered Quarto site that uses ipok: serves its
// _site/ on localhost, opens every page with questions (or the pages given)
// with ?ipok-debug, signed out, and for every variant of every question enters
// the answer shown by the debug panel and expects it to be accepted. Also fails
// on unfilled {{placeholders}} and console errors. Nothing is saved anywhere.
//
//   node check-site.mjs <site-dir> [page.html …] [--screenshots <dir>]
//
// Render the site first (quarto render). Uses the Playwright from this directory.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const shotsAt = args.indexOf("--screenshots");
const shots = shotsAt >= 0 ? resolve(args.splice(shotsAt, 2)[1]) : null;
if (!args.length) {
  console.error("usage: node check-site.mjs <site-dir> [page.html …] [--screenshots <dir>]");
  process.exit(2);
}
const root = resolve(args[0], "_site");
if (!existsSync(root)) { console.error(`${root} does not exist: render the site first`); process.exit(2); }
const PORT = 4175;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm" };

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "site_libs") yield* htmlFiles(path); }
    else if (name.endsWith(".html")) yield path;
  }
}
const pages = args.length > 1
  ? args.slice(1)
  : [...htmlFiles(root)].filter((p) => readFileSync(p, "utf8").includes("data-question-id=")).map((p) => relative(root, p));

const server = createServer((req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
  res.end(readFileSync(path));
}).listen(PORT);

let failures = 0, checked = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

// "variant v02 (1/3) · … · svar 9" (or "answer 9"); the answer is shown as text.
const debugAnswer = async (box) => {
  const line = await box.locator(".ipok-debug-line").textContent();
  const m = line.match(/variant (\S+) \((\d+)\/(\d+)\).* · (?:svar|answer) (.*?)(?: · |$)/);
  return { variant: m[1], count: +m[3], answer: m[4] };
};
const debugButton = (box, nth) => box.locator(".ipok-question-debug button").nth(nth); // 0: next variant, 1: reset

async function answer(box, value) {
  const radios = box.locator(".ipok-question-input input[type=radio]");
  if (await radios.count()) {
    const values = await radios.evaluateAll((xs) => xs.map((x) => x.value));
    if (!values.includes(value)) return false;
    await radios.nth(values.indexOf(value)).check();
  } else {
    await box.locator("input.ipok-answer").fill(value);
  }
  await box.locator(".ipok-buttons .btn-primary").click();
  return true;
}

const browser = await chromium.launch();
try {
  for (const page of pages) {
    console.log(page);
    const context = await browser.newContext();
    const tab = await context.newPage();
    const errors = [];
    tab.on("pageerror", (e) => errors.push(e.message));
    tab.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await tab.goto(`http://localhost:${PORT}/${page}?ipok-debug`);
    await tab.waitForSelector(".ipok-debug-panel", { timeout: 15000 }).catch(() => fail(`${page}: no debug panel`));
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await tab.waitForTimeout(1500); // MathJax
      await tab.screenshot({ path: join(shots, page.replace(/[\/]/g, "_") + ".png"), fullPage: true });
    }
    if ((await tab.locator("main").textContent()).includes("{{")) fail(`${page}: unfilled {{placeholder}}`);

    for (const box of await tab.locator(".question[data-question-id]").all()) {
      const id = await box.getAttribute("data-question-id");
      const { count } = await debugAnswer(box);
      const seen = new Set();
      for (let k = 0; k < count; k++) {
        await debugButton(box, 1).click(); // reset: first variant, attempt 0
        for (let i = 0; i < k; i++) await debugButton(box, 0).click();
        const { variant, answer: value } = await debugAnswer(box);
        seen.add(variant);
        checked++;
        if (!(await answer(box, value))) { fail(`${page} ${id} ${variant}: answer '${value}' is not among the options`); continue; }
        const status = box.locator(".ipok-buttons .ipok-status").first();
        if (!(await status.evaluate((s) => s.classList.contains("ok")))) {
          fail(`${page} ${id} ${variant}: answer '${value}' not accepted (${await status.textContent()})`);
        }
      }
      await debugButton(box, 1).click();
      if (seen.size !== count) fail(`${page} ${id}: saw ${seen.size} of ${count} variants`);
      else console.log(`  ok   ${id}: ${count} variant${count > 1 ? "s" : ""}`);
    }
    if (errors.length) fail(`${page}: console errors: ${errors.join("; ")}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${pages.length} page(s), ${checked} variants checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
