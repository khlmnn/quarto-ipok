// IPOK Progress: sign-in button in the navbar, a save/load widget for every
// `.exercise[data-exercise-id]` on the page (plain or code exercise),
// checked questions (`.question[data-question-id]`) whose variant depends on
// a per-student seed, and the progress table of a `.ipok-progress` page.
// Configuration is written by ipok.lua into
// <script id="ipok-config" type="application/json">.
(() => {
  "use strict";

  let cfg = null;
  let msalApp = null;

  const el = (tag, attrs = {}, children = []) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  };

  const account = () => msalApp.getActiveAccount() || msalApp.getAllAccounts()[0] || null;

  // ---- Auth -------------------------------------------------------------

  async function getToken() {
    const a = account();
    if (!a) throw new Error("Not signed in");
    try {
      const r = await msalApp.acquireTokenSilent({ scopes: [cfg.scope], account: a });
      return r.accessToken;
    } catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError) {
        await msalApp.acquireTokenRedirect({ scopes: [cfg.scope], account: a, redirectStartPage: location.href });
      }
      throw e;
    }
  }

  function login() {
    msalApp.loginRedirect({ scopes: ["openid", "profile", cfg.scope], redirectStartPage: location.href })
      .catch((e) => console.error("[ipok] login failed", e));
  }

  function logout() {
    msalApp.logoutRedirect({ account: account(), postLogoutRedirectUri: cfg.redirectUri });
  }

  // ---- API --------------------------------------------------------------

  async function api(method, path, body) {
    const token = await getToken();
    const res = await fetch(cfg.apiBase.replace(/\/$/, "") + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const enc = encodeURIComponent;
  const sectionPath = (module = cfg.module, section = cfg.section) =>
    `/api/Progress/${enc(cfg.courseInstance)}/modules/${enc(module)}/sections/${enc(section)}`;

  const putRecord = (exerciseId, exerciseData, module = cfg.module, section = cfg.section) =>
    api("PUT", `/api/Progress/${enc(cfg.courseInstance)}`, { moduleId: module, sectionId: section, exerciseId, exerciseData });

  const deleteRecord = (exerciseId, module = cfg.module, section = cfg.section) =>
    api("DELETE", `${sectionPath(module, section)}/exercises/${enc(exerciseId)}`);

  // Roles in the access token (the API's app roles, e.g. "Teacher").
  async function tokenRoles() {
    try {
      const part = (await getToken()).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const roles = JSON.parse(decodeURIComponent(escape(atob(part)))).roles;
      return Array.isArray(roles) ? roles : [];
    } catch {
      return [];
    }
  }

  // ---- Navbar -----------------------------------------------------------

  let authBox = null;

  function renderNavbar() {
    if (!authBox) {
      authBox = el("div", { class: "ipok-auth" });
      const host = document.querySelector(".quarto-navbar-tools") || document.querySelector("#navbarCollapse");
      if (host) host.appendChild(authBox);
      else {
        authBox.style.cssText = "position:fixed;top:.5rem;right:.5rem;z-index:2000";
        document.body.appendChild(authBox);
      }
    }
    authBox.replaceChildren();
    const a = account();
    if (a) {
      authBox.appendChild(el("span", { class: "ipok-user", text: a.name || a.username, title: a.username }));
      if (cfg.progressPage) authBox.appendChild(el("a", { class: "ipok-progress-link", href: cfg.progressPage, text: t("myPage") }));
      const b = el("button", { class: "btn btn-sm btn-outline-light", type: "button", text: "Sign out" });
      b.onclick = logout;
      authBox.appendChild(b);
    } else {
      const b = el("button", { class: "btn btn-sm btn-light", type: "button", text: "Sign in" });
      b.onclick = login;
      authBox.appendChild(b);
    }
  }

  // ---- Exercise widgets -------------------------------------------------
  //
  // An exercise div that contains a quarto-live Pyodide cell is a *code*
  // exercise: it saves automatically when Run is pressed, storing
  // {code, output} with code = null if the student left it unchanged.
  // Any other exercise div is a *plain* exercise with a text box and PUT.

  const widgets = new Map(); // exerciseId -> widget

  const tick = () => new Promise((r) => setTimeout(r, 0));

  const sampleData = (id) =>
    JSON.stringify({ exerciseId: id, note: "Sample data from ete335-test", generatedAt: new Date().toISOString() }, null, 2);

  // Same encoding as quarto-live's json_as_b64 (base64 of UTF-8 JSON).
  const b64Json = (s) => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));

  function setStatus(w, text, kind = "") {
    w.status.textContent = text;
    w.status.className = "ipok-status " + kind;
  }

  function renderPlainWidget(div, id) {
    const status = el("span", { class: "ipok-status" });
    const stored = el("pre", { class: "ipok-stored" });
    stored.hidden = true;
    const input = el("textarea", { class: "form-control", "aria-label": `Data for ${id}` });
    input.value = sampleData(id);
    const put = el("button", { class: "btn btn-sm btn-primary", type: "button", text: "Save (PUT)" });
    const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", text: "Delete" });
    const w = { kind: "plain", id, status, stored, input, buttons: [put, del] };
    put.onclick = () => save(w, input.value);
    del.onclick = () => remove(w);
    div.appendChild(el("div", { class: "ipok-widget" }, [
      el("div", { class: "ipok-widget-head" }, [el("code", { text: id }), document.createTextNode(" · "), status]),
      stored,
      input,
      el("div", { class: "ipok-buttons" }, [put, del]),
    ]));
    return w;
  }

  function renderCodeWidget(div, id, cell) {
    const script = div.querySelector(`script[type="${cell.id}-contents"]`);
    const initialCode = script ? b64Json(script.textContent).code : null;
    const status = el("span", { class: "ipok-status" });
    const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", text: "Delete saved" });
    const w = { kind: "code", id, cell, initialCode, status, buttons: [del], runToken: 0, loaded: false, restoredOutput: null };
    del.onclick = () => remove(w);
    div.appendChild(el("div", { class: "ipok-widget" }, [
      el("div", { class: "ipok-widget-head" }, [
        el("code", { text: id }), document.createTextNode(" · saved when you press Run · "), status,
      ]),
      el("div", { class: "ipok-buttons" }, [del]),
    ]));
    if (!initialCode) console.warn(`[ipok] ${id}: could not read the cell's initial code`);
    return w;
  }

  function renderWidgets() {
    for (const div of document.querySelectorAll(".exercise[data-exercise-id]")) {
      const id = div.dataset.exerciseId;
      const cells = div.querySelectorAll(".exercise-cell[id^='pyodide-']");
      if (cells.length > 1) console.warn(`[ipok] ${id}: several code cells, only the first is saved`);
      widgets.set(id, cells.length ? renderCodeWidget(div, id, cells[0]) : renderPlainWidget(div, id));
    }
    updateWidgets();
  }

  function updateWidgets() {
    const signedIn = !!account();
    for (const w of widgets.values()) {
      w.buttons.forEach((b) => (b.disabled = !signedIn));
      if (w.input) w.input.disabled = !signedIn;
      if (!signedIn) setStatus(w, w.kind === "code" ? "sign in to save your code" : "sign in to load and save");
    }
  }

  function showStored(w, ex) {
    if (!ex) {
      if (w.kind === "plain") w.stored.hidden = true;
      setStatus(w, "nothing saved yet");
      w.loaded = true;
      return;
    }
    setStatus(w, `saved ${new Date(ex.completed).toLocaleString()}`, "ok");
    if (w.kind === "plain") {
      w.stored.hidden = false;
      w.stored.textContent = ex.exerciseData ?? "";
      return;
    }
    // Code and output are restored once per page load; later reloads of the
    // progress (after each save) only update the status line.
    if (w.loaded) return;
    w.loaded = true;
    let data = {};
    try { data = JSON.parse(ex.exerciseData || "{}"); } catch { console.warn(`[ipok] ${w.id}: stored data is not JSON`); }
    if (typeof data.code === "string") restoreCode(w, data.code);
    if (Array.isArray(data.output) && data.output.length) restoreOutput(w, data.output);
  }

  // ---- Code exercises: restore, capture Run, read output ----------------

  function waitFor(root, find) {
    return new Promise((resolve) => {
      const hit = find();
      if (hit) return resolve(hit);
      const mo = new MutationObserver(() => {
        const hit = find();
        if (hit) { mo.disconnect(); resolve(hit); }
      });
      mo.observe(root, { childList: true, subtree: true });
    });
  }

  // CodeMirror's EditorView.findFromDOM, without access to the bundled class.
  function editorView(content) {
    const tile = content.cmTile || content.cmView;
    return tile?.root?.view || tile?.rootView?.view || null;
  }

  async function restoreCode(w, code) {
    const content = await waitFor(w.cell, () => w.cell.querySelector(".cm-content"));
    const view = editorView(content);
    if (!view) {
      console.warn(`[ipok] ${w.id}: could not find the editor to restore saved code`);
      setStatus(w, "saved code could not be restored into the editor", "err");
      return;
    }
    if (view.state.doc.toString() !== code) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    }
  }

  // Images larger than this (as data URL) are stored as {kind: "image"} only.
  const MAX_IMAGE_CHARS = 500_000;
  const IMAGE_URL = /^data:image\/(png|jpeg|gif);base64,\s*[A-Za-z0-9+/=]+$/;

  function imageSrc(n) {
    const img = n.querySelector("img");
    if (img) return img.getAttribute("src") || "";
    const canvas = n.querySelector("canvas");
    try { return canvas ? canvas.toDataURL("image/png") : ""; } catch { return ""; }
  }

  // Output items: stdout / stderr / display (text repr of the last
  // expression) / html (HTML repr, stored as its text only) / image.
  function readOutput(container) {
    const sel = ".cell-output, .cell-output-display";
    return [...container.querySelectorAll(sel)]
      .filter((n) => !n.parentElement.closest(sel)) // skip nested matches
      .map((n) => {
        if (n.classList.contains("cell-output-stdout")) return { kind: "stdout", text: n.textContent };
        if (n.classList.contains("cell-output-stderr")) return { kind: "stderr", text: n.textContent };
        const pic = n.querySelector("img, canvas");
        if (pic) {
          const src = imageSrc(n);
          // Plots are drawn on a high-resolution canvas scaled down by CSS;
          // keep the displayed width so the restored image matches.
          const width = Math.round(parseFloat(pic.style.width) || pic.getBoundingClientRect().width) || undefined;
          return IMAGE_URL.test(src) && src.length <= MAX_IMAGE_CHARS ? { kind: "image", src, width } : { kind: "image" };
        }
        const only = n.children.length === 1 ? n.firstElementChild : null;
        if (only?.tagName === "PRE" && only.querySelector(":scope > code")) return { kind: "display", text: n.textContent };
        return { kind: "html", text: n.textContent.trim() };
      });
  }

  // Rebuild saved output with quarto-live's own markup so it looks like a
  // real run. It goes after the cell's OJS output slot (which quarto-live
  // replaces once Pyodide has loaded) and is removed on the next Run or
  // Start Over. Built with textContent / validated data URLs only.
  function restoreOutput(w, output) {
    const pre = (text) => el("pre", {}, [el("code", { text })]);
    const box = el("div", { class: "cell-output-container cell-output-container-pyodide ipok-restored-output" });
    for (const o of output) {
      if (o.kind === "stdout" || o.kind === "stderr") {
        box.appendChild(el("div", { class: `exercise-cell-output cell-output cell-output-pyodide cell-output-${o.kind}` }, [pre(o.text ?? "")]));
      } else if (o.kind === "image") {
        const node = IMAGE_URL.test(o.src || "")
          ? el("img", { src: o.src, alt: "Saved plot", class: "img-fluid figure-img", ...(Number(o.width) > 0 ? { style: `width: ${Number(o.width)}px;` } : {}) })
          : el("em", { text: "(image not saved)" });
        box.appendChild(el("div", { class: "cell-output-display cell-output-pyodide" }, [node]));
      } else {
        box.appendChild(el("div", { class: "cell-output cell-output-pyodide" }, [pre(o.text ?? "")]));
      }
    }
    clearRestoredOutput(w);
    w.restoredOutput = box;
    w.cell.appendChild(box);
  }

  function clearRestoredOutput(w) {
    w.restoredOutput?.remove();
    w.restoredOutput = null;
  }

  async function onRun(w, editorContainer) {
    clearRestoredOutput(w);
    if (!account()) return;
    const token = ++w.runToken;
    const before = w.cell.querySelector(".cell-output-container");
    await tick(); // let quarto-live update the editor's value first
    const code = editorContainer.value?.code;
    if (typeof code !== "string") return;
    setStatus(w, "running…");
    // Each run renders a fresh output container once evaluation is done.
    const out = await waitFor(w.cell, () => {
      const c = w.cell.querySelector(".cell-output-container");
      return c && c !== before ? c : null;
    });
    if (token !== w.runToken) return; // a newer run took over
    const unchanged = w.initialCode !== null && code.trimEnd() === w.initialCode.trimEnd();
    await save(w, JSON.stringify({ code: unchanged ? null : code, output: readOutput(out) }));
  }

  // quarto-live signals Run (button or Ctrl/Cmd-Enter) with a non-bubbling
  // CustomEvent("input", {detail: {commit: true}}) on the editor container;
  // "Start Over" sends the same event with an explicit `code`: it clears
  // the output like a fresh cell but is not saved.
  document.addEventListener("input", (e) => {
    const d = e.detail;
    if (!(e instanceof CustomEvent) || !d || d.commit !== true) return;
    const div = e.target.closest?.(".exercise[data-exercise-id]");
    const w = div && widgets.get(div.dataset.exerciseId);
    if (w?.kind !== "code" || !w.cell.contains(e.target)) return;
    if ("code" in d) clearRestoredOutput(w);
    else onRun(w, e.target);
  }, true);

  // ---- Checked questions ------------------------------------------------
  //
  // Each question has a table of variants (from ipok.lua). A per-student seed
  // fixes the order in which a student meets the variants: variant ids are
  // sorted by hash(seed, question, variant id), so adding a variant to a table
  // moves only the students whose order it lands in front of. A multiple-choice
  // question shows the next variant in that order after each wrong answer;
  // number and text questions always show the first. The state of a question
  // is saved as an ordinary progress record, {attempt, variant, solved, answers}.
  //
  // The seed is the record (_ipok, _ipok, seed) = {"seed": <uint32>}, created at
  // first sign-in as the first 4 bytes of SHA-256("<course-instance>:<account
  // id>"). Signed-out visitors get a random seed in localStorage and nothing is
  // saved.

  const SEED_MODULE = "_ipok";
  const SEED_ID = "seed";

  const STRINGS = {
    en: {
      answer: "Answer", correct: "Correct!", wrong: "Wrong.", newQuestion: "New question",
      tryAgain: "Wrong, try again.", notANumber: "Enter a number, for example 3.5.",
      empty: "Enter an answer.", choose: "Choose an option.", signIn: "Sign in to save your answers.",
      loading: "Loading…", loadFailed: "Could not load the question: ", saveFailed: "Could not save your answer: ",
      answerLabel: "Your answer",
      dSeed: "Seed", dRead: "Read", dSave: "Save", dDerived: "Reset to derived", dRandom: "New random",
      dAll: "Show all variants", dNext: "Next variant", dReset: "Reset", dVariant: "variant",
      dAttempt: "attempt", dSolved: "solved", dAnswer: "answer", dOffset: "debug offset, not saved",
      dLocal: "signed out: local seed, nothing is saved",
      myPage: "My page", pPage: "Page", pSolved: "Solved", pTotal: "Total",
      pSignIn: "Sign in to see your progress.", pNone: "There are no questions yet.",
      pLoadFailed: "could not be loaded",
    },
    sv: {
      answer: "Svara", correct: "Rätt!", wrong: "Fel.", newQuestion: "Ny fråga",
      tryAgain: "Fel, försök igen.", notANumber: "Skriv ett tal, till exempel 3,5.",
      empty: "Skriv ett svar.", choose: "Välj ett alternativ.", signIn: "Logga in för att spara dina svar.",
      loading: "Laddar …", loadFailed: "Kunde inte ladda frågan: ", saveFailed: "Kunde inte spara ditt svar: ",
      answerLabel: "Ditt svar",
      dSeed: "Seed", dRead: "Läs", dSave: "Spara", dDerived: "Återställ härledd", dRandom: "Ny slumpad",
      dAll: "Visa alla varianter", dNext: "Nästa variant", dReset: "Återställ", dVariant: "variant",
      dAttempt: "försök", dSolved: "löst", dAnswer: "svar", dOffset: "debug-förskjutning, sparas inte",
      dLocal: "utloggad: lokal seed, inget sparas",
      myPage: "Min sida", pPage: "Sida", pSolved: "Rätt besvarade", pTotal: "Totalt",
      pSignIn: "Logga in för att se dina framsteg.", pNone: "Det finns inga frågor än.",
      pLoadFailed: "kunde inte laddas",
    },
  };
  const t = (key) => (STRINGS[(cfg.lang || "en").slice(0, 2)] || STRINGS.en)[key];

  const questions = new Map(); // questionId -> question
  let seed = null;
  let debug = null; // {panel, all: boolean} when the debug panel is shown

  // cyrb53: a fast 53-bit string hash (public domain).
  function hash53(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  // Items sorted by hash(key(item)), ties by key.
  function hashOrder(items, key) {
    return items
      .map((item) => ({ item, k: key(item), h: hash53(key(item)) }))
      .sort((a, b) => a.h - b.h || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map((x) => x.item);
  }

  const variantOrder = (q) => hashOrder(q.variants, (v) => `${seed}|${q.id}|${v.id}`);

  // The variant to show: the solved one, else by attempt (mcq) or the first.
  function currentVariant(q) {
    const s = q.state;
    if (s.solved) {
      const v = q.variants.find((x) => x.id === s.variant);
      if (v) return v;
    }
    const order = variantOrder(q);
    const k = (q.type === "mcq" ? s.attempt : 0) + q.debugOffset;
    return order[k % order.length];
  }

  const optionOrder = (q, v) => hashOrder(v.options, (o) => `${seed}|${q.id}|${q.state.attempt}|${o}`);

  // ---- Checking

  function parseNumber(s) {
    const x = s.replace(/[\s  ]/g, "").replace(/^[−–]/, "-");
    if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(x)) return null;
    return Number(x.replace(",", "."));
  }

  // Rounds half away from zero on the decimal digits as written, as by hand:
  // 0.045 -> 0.05 (toFixed works on the binary value 0.04499… and gives 0.04).
  function roundHalfUp(n, decimals) {
    const s = String(Math.abs(n));
    if (/e/i.test(s)) return Number(n.toFixed(decimals)); // tiny or huge: no half to decide
    return Math.sign(n) * Number(Math.round(Number(`${s}e${decimals}`)) + `e-${decimals}`);
  }

  const normalizeText = (s, ignoreCase) => {
    const x = s.normalize("NFC").trim().replace(/\s+/g, " ");
    return ignoreCase ? x.toLocaleLowerCase(cfg.lang) : x;
  };

  // {ok: true, correct} or {ok: false, hint} for input that is not an answer.
  function check(q, v, value) {
    if (q.type === "mcq") {
      if (value == null) return { ok: false, hint: t("choose") };
      return { ok: true, correct: value === v.answer };
    }
    if (value.trim() === "") return { ok: false, hint: t("empty") };
    if (q.type === "text") {
      return { ok: true, correct: normalizeText(value, q.ignoreCase) === normalizeText(v.answer, q.ignoreCase) };
    }
    const x = parseNumber(value);
    if (x === null) return { ok: false, hint: t("notANumber") };
    if (q.decimals != null) return { ok: true, correct: roundHalfUp(x, q.decimals) === roundHalfUp(v.answer, q.decimals) };
    if (q.tolerance != null) return { ok: true, correct: Math.abs(x - v.answer) <= q.tolerance + 1e-12 };
    return { ok: true, correct: x === v.answer };
  }

  // ---- Seed

  async function derivedSeed() {
    const a = account();
    const bytes = new TextEncoder().encode(`${cfg.courseInstance}:${a.localAccountId || a.homeAccountId}`);
    const digest = new DataView(await crypto.subtle.digest("SHA-256", bytes));
    return digest.getUint32(0);
  }

  const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const validSeed = (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
  const localSeedKey = () => `ipok-seed:${cfg.courseInstance}`;

  function readLocalSeed() {
    try {
      const x = Number(localStorage.getItem(localSeedKey()));
      if (localStorage.getItem(localSeedKey()) !== null && validSeed(x)) return x;
    } catch { /* storage blocked */ }
    return null;
  }

  function writeLocalSeed(x) {
    try { localStorage.setItem(localSeedKey(), String(x)); } catch { /* storage blocked */ }
  }

  async function readStoredSeed() {
    const section = await api("GET", sectionPath(SEED_MODULE, SEED_MODULE));
    const ex = (section?.exercises || []).find((x) => x.exerciseId === SEED_ID);
    try {
      const x = JSON.parse(ex?.exerciseData ?? "null")?.seed;
      return validSeed(x) ? x : null;
    } catch {
      return null;
    }
  }

  const writeStoredSeed = (x) => putRecord(SEED_ID, JSON.stringify({ seed: x }), SEED_MODULE, SEED_MODULE);

  async function loadSeed() {
    if (!account()) {
      let x = readLocalSeed();
      if (x === null) { x = randomSeed(); writeLocalSeed(x); }
      return x;
    }
    let x = await readStoredSeed();
    if (x === null) {
      x = await derivedSeed();
      await writeStoredSeed(x);
    }
    return x;
  }

  // ---- State

  const freshState = () => ({ attempt: 0, variant: null, solved: false, answers: [] });

  function parseState(ex) {
    let d = {};
    try { d = JSON.parse(ex?.exerciseData || "{}") || {}; } catch { /* not JSON */ }
    return {
      attempt: Number.isInteger(d.attempt) && d.attempt >= 0 ? d.attempt : 0,
      variant: typeof d.variant === "string" ? d.variant : null,
      solved: d.solved === true,
      answers: Array.isArray(d.answers) ? d.answers : [],
    };
  }

  async function saveState(q) {
    if (!account()) return;
    try {
      await putRecord(q.id, JSON.stringify(q.state));
    } catch (e) {
      console.error("[ipok]", e);
      setQStatus(q, t("saveFailed") + e.message, "err");
    }
  }

  // ---- Rendering

  // MathJax typesets the page once it has loaded; content added before that
  // is included, content added later is typeset here.
  function typeset(node) {
    const mj = window.MathJax;
    if (!mj?.startup?.promise || !mj.typesetPromise) return;
    mj.startup.promise
      .then(() => mj.typesetPromise([node]))
      .catch((e) => console.warn("[ipok] MathJax", e));
  }

  function replaceContent(node, children) {
    window.MathJax?.typesetClear?.([node]);
    node.replaceChildren(...children);
    typeset(node);
  }

  // The question text with {{placeholders}} filled in, as text only. A
  // placeholder may span several text nodes: syntax highlighting splits
  // "{{name}}" in a Python string into "{", "{name}", "}" spans. The value goes
  // into the first node, and the rest of the placeholder is cut from the others.
  function questionText(q, v) {
    const frag = q.template.content.cloneNode(true);
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    const nodes = [];
    const starts = []; // offset of each node in the concatenated text
    let text = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    const nodeAt = (offset) => { // last node starting at or before offset
      let i = 0;
      while (i + 1 < nodes.length && starts[i + 1] <= offset) i++;
      return i;
    };
    const matches = [...text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].filter((m) => m[1] in v);
    for (const m of matches.reverse()) { // from the end, so earlier offsets stay valid
      const begin = m.index, end = m.index + m[0].length;
      const first = nodeAt(begin), last = nodeAt(end - 1);
      const a = nodes[first], b = nodes[last];
      const tail = b.data.slice(end - starts[last]);
      for (let i = first + 1; i < last; i++) nodes[i].data = "";
      if (last !== first) b.data = tail;
      a.data = a.data.slice(0, begin - starts[first]) + String(v[m[1]]) + (last === first ? tail : "");
    }
    return frag;
  }

  function setQStatus(q, text, kind = "") {
    q.status.textContent = text;
    q.status.className = "ipok-status " + kind;
  }

  const lastCorrect = (q) => [...q.state.answers].reverse().find((a) => a.correct)?.answer;

  // q.view is "answering", or "wrong" while a wrongly answered mcq variant
  // waits for "New question" (see renderWrong); rendering anew ends that.
  function renderQuestion(q) {
    q.view = "answering";
    const v = currentVariant(q);
    q.shown = v;
    const solved = q.state.solved;
    replaceContent(q.body, [questionText(q, v)]);

    if (q.type === "mcq") {
      const name = `ipok-${q.id}`;
      const chosen = solved ? lastCorrect(q) : null;
      const items = optionOrder(q, v).map((o) => {
        const input = el("input", { type: "radio", name, class: "form-check-input", value: o });
        input.checked = o === chosen;
        input.disabled = solved;
        return el("label", { class: "ipok-check" }, [input, el("span", { text: o })]);
      });
      replaceContent(q.input, items);
    } else {
      const input = el("input", {
        type: "text", class: "form-control ipok-answer", "aria-label": t("answerLabel"), autocomplete: "off",
        ...(q.type === "number" ? { inputmode: "decimal" } : {}),
      });
      if (solved) input.value = lastCorrect(q) ?? "";
      else if (q.keep != null) input.value = q.keep;
      input.disabled = solved;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(q); } });
      q.input.replaceChildren(input);
    }

    q.submitButton.hidden = solved;
    q.newButton.hidden = true;
    if (solved) setQStatus(q, t("correct"), "ok");
    else if (q.hint) setQStatus(q, q.hint, q.hintKind || "");
    else setQStatus(q, "");
    q.note.hidden = !!account();
    renderQuestionDebug(q);
  }

  function readAnswer(q) {
    if (q.type === "mcq") return q.input.querySelector("input:checked")?.value ?? null;
    return q.input.querySelector("input").value;
  }

  function submit(q) {
    if (q.state.solved || q.view !== "answering") return;
    const v = q.shown;
    const value = readAnswer(q);
    const r = check(q, v, value);
    if (!r.ok) {
      setQStatus(q, r.hint, "err");
      return;
    }
    const s = q.state;
    s.answers.push({ variant: v.id, answer: value, correct: r.correct });
    s.variant = v.id;
    q.hint = null;
    q.keep = null;
    if (r.correct) {
      s.solved = true;
    } else {
      s.attempt += 1;
      if (q.type === "mcq") {
        q.view = "wrong";
      } else {
        q.hint = t("tryAgain");
        q.hintKind = "err";
        q.keep = value;
      }
    }
    // A wrong mcq answer keeps the answered variant on screen until "New
    // question"; the saved attempt already points at the next one.
    if (q.view === "wrong") renderWrong(q, v);
    else renderQuestion(q);
    saveState(q);
  }

  // The answered variant stays on screen, with its options in the order the
  // student saw them, until "New question".
  function renderWrong(q, v) {
    for (const input of q.input.querySelectorAll("input")) input.disabled = true;
    q.submitButton.hidden = true;
    q.newButton.hidden = false;
    setQStatus(q, t("wrong"), "err");
    renderQuestionDebug(q, v);
  }


  function setupQuestion(div, data) {
    const template = div.querySelector(":scope > template.ipok-question-template");
    if (!template) { console.warn(`[ipok] ${data.id}: no question template`); return null; }
    const q = {
      ...data, div, template, debugOffset: 0, state: freshState(), view: "answering",
      body: el("div", { class: "ipok-question-body" }),
      input: el("div", { class: "ipok-question-input" }),
      status: el("span", { class: "ipok-status", role: "status" }),
      submitButton: el("button", { class: "btn btn-sm btn-primary", type: "button", text: t("answer") }),
      newButton: el("button", { class: "btn btn-sm btn-outline-primary", type: "button", text: t("newQuestion") }),
      note: el("div", { class: "ipok-question-note", text: t("signIn") }),
      debugBox: el("div", { class: "ipok-question-debug" }),
    };
    q.submitButton.onclick = () => submit(q);
    q.newButton.onclick = () => renderQuestion(q);
    q.newButton.hidden = true;
    q.debugBox.hidden = true;
    div.append(q.body, q.input,
      el("div", { class: "ipok-buttons" }, [q.submitButton, q.newButton, q.status]), q.note, q.debugBox);
    setQStatus(q, t("loading"));
    q.submitButton.disabled = true;
    return q;
  }

  async function initQuestions() {
    const list = Array.isArray(cfg.questions) ? cfg.questions : [];
    for (const data of list) {
      const div = document.querySelector(`.question[data-question-id="${CSS.escape(data.id)}"]`);
      const q = div && setupQuestion(div, data);
      if (q) questions.set(q.id, q);
    }
    const signedIn = !!account();
    let section = null;
    try {
      if (signedIn && (widgets.size || questions.size)) section = await api("GET", sectionPath());
      if (questions.size) seed = await loadSeed();
    } catch (e) {
      console.error("[ipok]", e);
      for (const q of questions.values()) setQStatus(q, t("loadFailed") + e.message, "err");
      if (signedIn) await loadProgress();
      return;
    }
    if (signedIn) await loadProgress({ section });
    const byId = new Map((section?.exercises || []).map((x) => [x.exerciseId, x]));
    for (const q of questions.values()) {
      q.state = parseState(byId.get(q.id));
      q.submitButton.disabled = false;
      renderQuestion(q);
    }
    if (questions.size) await initDebug();
  }

  // ---- Debug panel
  //
  // Shown with ?ipok-debug, to signed-in users with the Teacher role, and to
  // anyone signed out on localhost (quarto preview, where sign-in does not
  // work; only the local seed is involved there).

  async function initDebug() {
    if (!new URLSearchParams(location.search).has("ipok-debug")) return;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    const allowed = account() ? (await tokenRoles()).includes("Teacher") : local;
    if (!allowed) { console.info("[ipok] debug panel: needs the Teacher role (or localhost when signed out)"); return; }

    const field = el("input", { type: "text", class: "form-control form-control-sm", "aria-label": t("dSeed"), inputmode: "numeric" });
    const status = el("span", { class: "ipok-status" });
    const button = (text, onclick) => { const b = el("button", { class: "btn btn-sm btn-outline-secondary", type: "button", text }); b.onclick = onclick; return b; };
    const all = el("input", { type: "checkbox", class: "form-check-input" });
    const show = () => { field.value = String(seed); };

    const apply = async (x, { store = true } = {}) => {
      if (!validSeed(x)) { status.textContent = "0 … 4294967295"; status.className = "ipok-status err"; return; }
      try {
        if (store) { if (account()) await writeStoredSeed(x); else writeLocalSeed(x); }
        seed = x;
        show();
        status.textContent = "";
        for (const q of questions.values()) { q.debugOffset = 0; q.hint = null; q.keep = null; renderQuestion(q); }
      } catch (e) {
        status.textContent = e.message; status.className = "ipok-status err";
      }
    };

    const buttons = [
      button(t("dRead"), async () => {
        try { await apply(account() ? (await readStoredSeed()) ?? seed : readLocalSeed() ?? seed, { store: false }); }
        catch (e) { status.textContent = e.message; status.className = "ipok-status err"; }
      }),
      button(t("dSave"), () => apply(/^\d+$/.test(field.value.trim()) ? Number(field.value.trim()) : NaN)),
      account() ? button(t("dDerived"), async () => apply(await derivedSeed())) : button(t("dRandom"), () => apply(randomSeed())),
    ];
    all.onchange = () => { debug.all = all.checked; for (const q of questions.values()) renderQuestionDebug(q); };

    const panel = el("details", { class: "ipok-debug-panel", open: "" }, [
      el("summary", { text: "ipok debug" }),
      el("div", { class: "ipok-debug-row" }, [el("label", { text: t("dSeed") }), field]),
      el("div", { class: "ipok-buttons" }, buttons),
      el("label", { class: "ipok-check" }, [all, el("span", { text: t("dAll") })]),
      ...(account() ? [] : [el("div", { class: "ipok-question-note", text: t("dLocal") })]),
      status,
    ]);
    document.body.appendChild(panel);
    debug = { panel, all: false };
    show();
    for (const q of questions.values()) renderQuestionDebug(q);
  }

  function renderQuestionDebug(q, shown = q.shown) {
    if (!debug) return;
    const order = variantOrder(q);
    const s = q.state;
    const fmt = (x) => (Array.isArray(x) ? x.join(" | ") : String(x));
    const line = [
      `${t("dVariant")} ${shown.id} (${order.indexOf(shown) + 1}/${order.length})`,
      `${t("dAttempt")} ${s.attempt}`,
      `${t("dSolved")} ${s.solved ? "✓" : "–"}`,
      `${t("dAnswer")} ${fmt(shown.answer)}`,
      ...(q.debugOffset ? [`+${q.debugOffset} (${t("dOffset")})`] : []),
    ].join(" · ");

    const next = el("button", { class: "btn btn-sm btn-outline-secondary", type: "button", text: t("dNext") });
    next.onclick = () => {
      // mcq: a real attempt, saved; number/text: only a local offset, since
      // their variant does not depend on the attempt.
      if (q.type === "mcq" && !s.solved) { s.attempt += 1; saveState(q); }
      else q.debugOffset += 1;
      q.hint = null; q.keep = null;
      renderQuestion(q);
    };
    const reset = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", text: t("dReset") });
    reset.onclick = async () => {
      try { if (account()) await deleteRecord(q.id); }
      catch (e) { setQStatus(q, e.message, "err"); return; }
      q.state = freshState(); q.debugOffset = 0; q.hint = null; q.keep = null;
      renderQuestion(q);
    };

    const children = [el("div", { class: "ipok-debug-line", text: line }), el("div", { class: "ipok-buttons" }, [next, reset])];
    if (debug.all) {
      const keys = [...new Set(q.variants.flatMap((v) => Object.keys(v)))];
      const row = (cells, tag) => el("tr", {}, cells.map((c) => el(tag, { text: c })));
      children.push(el("table", { class: "table table-sm ipok-debug-table" }, [
        el("thead", {}, [row(["#", ...keys], "th")]),
        el("tbody", {}, order.map((v, i) => {
          const tr = row([String(i + 1), ...keys.map((k) => (k in v ? fmt(v[k]) : ""))], "td");
          if (v === shown) tr.className = "table-active";
          return tr;
        })),
      ]));
    }
    q.debugBox.hidden = false;
    q.debugBox.replaceChildren(...children);
  }

  // `.ipok-name` spans (the ipok-name shortcode) get the signed-in user's
  // name; signed out, they keep their content.
  function renderNames() {
    const a = account();
    if (!a) return;
    for (const s of document.querySelectorAll(".ipok-name")) s.textContent = a.name || a.username;
  }

  // ---- Progress page ------------------------------------------------------
  //
  // A `.ipok-progress` div gets a table of the site's pages with questions
  // (listed by ipok.lua when the page is rendered) and, for each, how many of
  // its questions the student has solved. Only questions still on a page
  // count. One GET per section, all at once. Once every section has loaded,
  // a `.ipok-gate` div (hidden by ipok.lua) is shown if every question is
  // solved, and a `.ipok-gate-closed` div if not.

  async function initProgress() {
    const boxes = [...document.querySelectorAll(".ipok-progress")];
    const gates = [...document.querySelectorAll(".ipok-gate, .ipok-gate-closed")];
    if (!boxes.length && !gates.length) return;
    const pages = Array.isArray(cfg.progress) ? cfg.progress : [];
    const show = (...children) => { for (const b of boxes) b.replaceChildren(...children.map((c) => c.cloneNode(true))); };
    if (!account()) { show(el("p", { class: "ipok-question-note", text: t("pSignIn") })); return; }
    if (!pages.length) { show(el("p", { text: t("pNone") })); return; }
    show(el("p", { class: "ipok-status", text: t("loading") }));

    const key = (p) => `${p.module}\u0000${p.section}`;
    const keys = [...new Map(pages.map((p) => [key(p), p])).values()];
    const solved = new Map(await Promise.all(keys.map(async (p) => {
      try {
        const section = await api("GET", sectionPath(p.module, p.section));
        const ids = (section?.exercises || []).filter((x) => parseState(x).solved).map((x) => x.exerciseId);
        return [key(p), new Set(ids)];
      } catch (e) {
        console.error("[ipok]", e);
        return [key(p), null];
      }
    })));

    let total = 0, done = 0, failed = 0;
    const row = (cells, tag = "td") => el("tr", {}, cells.map((c) => (typeof c === "string" ? el(tag, { text: c }) : el(tag, {}, [c]))));
    const rows = pages.map((p) => {
      const s = solved.get(key(p));
      const n = p.questions.length;
      const x = s ? p.questions.filter((id) => s.has(id)).length : 0;
      total += n; done += x;
      if (!s) failed++;
      const tr = row([el("a", { href: p.href, text: p.title }), s ? `${x} / ${n}` : t("pLoadFailed")]);
      tr.dataset.section = `${p.module}/${p.section}`;
      if (!s) tr.lastChild.className = "ipok-status err";
      else if (x === n) tr.lastChild.className = "ipok-status ok";
      return tr;
    });
    show(el("table", { class: "table ipok-progress-table" }, [
      el("thead", {}, [row([t("pPage"), t("pSolved")], "th")]),
      el("tbody", {}, rows),
      el("tfoot", {}, [row([t("pTotal"), `${done} / ${total}`], "th")]),
    ]));
    if (failed === 0) {
      const passed = total > 0 && done === total;
      for (const g of gates) g.hidden = g.classList.contains("ipok-gate") !== passed;
    }
  }

  // ---- Load / save / delete ---------------------------------------------

  // `quiet` refreshes after a save or delete without flashing "loading…".
  async function loadProgress({ quiet = false, section = null } = {}) {
    if (widgets.size === 0) return;
    if (!quiet) for (const w of widgets.values()) setStatus(w, "loading…");
    try {
      section ??= await api("GET", sectionPath());
      const byId = new Map((section?.exercises || []).map((x) => [x.exerciseId, x]));
      for (const [id, w] of widgets) showStored(w, byId.get(id));
      const orphans = [...byId.keys()].filter((id) => !widgets.has(id) && !questions.has(id));
      if (orphans.length) console.info("[ipok] stored exercises not on this page:", orphans);
    } catch (e) {
      console.error("[ipok]", e);
      for (const w of widgets.values()) setStatus(w, `load failed: ${e.message}`, "err");
    }
  }

  async function save(w, exerciseData) {
    setStatus(w, "saving…");
    try {
      await putRecord(w.id, exerciseData);
      await loadProgress({ quiet: true });
    } catch (e) {
      console.error("[ipok]", e);
      setStatus(w, `save failed: ${e.message}`, "err");
    }
  }

  async function remove(w) {
    setStatus(w, "deleting…");
    try {
      await deleteRecord(w.id);
      if (w.kind === "code") clearRestoredOutput(w);
      await loadProgress({ quiet: true });
    } catch (e) {
      console.error("[ipok]", e);
      setStatus(w, `delete failed: ${e.message}`, "err");
    }
  }

  // ---- Init -------------------------------------------------------------

  async function init() {
    const node = document.getElementById("ipok-config");
    if (!node) return;
    cfg = JSON.parse(node.textContent);
    msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
        redirectUri: cfg.redirectUri,
        postLogoutRedirectUri: cfg.redirectUri,
        navigateToLoginRequestUrl: true,
        // Query instead of fragment, so the response doesn't collide with
        // Quarto's handling of #anchors on page load.
        OIDCOptions: { serverResponseType: "query" },
      },
      cache: { cacheLocation: "sessionStorage" },
    });
    try {
      await msalApp.initialize();
      const r = await msalApp.handleRedirectPromise();
      if (r?.account) msalApp.setActiveAccount(r.account);
    } catch (e) {
      console.error("[ipok] MSAL error", e);
    }
    renderNavbar();
    renderNames();
    renderWidgets();
    await initQuestions();
    await initProgress();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
