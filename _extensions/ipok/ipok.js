// IPOK Progress: sign-in button in the navbar plus a save/load widget for
// every `.exercise[data-exercise-id]` on the page (plain or code exercise). Configuration is written
// by ipok.lua into <script id="ipok-config" type="application/json">.
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
  const sectionPath = () =>
    `/api/Progress/${enc(cfg.courseInstance)}/modules/${enc(cfg.module)}/sections/${enc(cfg.section)}`;

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

  // ---- Load / save / delete ---------------------------------------------

  // `quiet` refreshes after a save or delete without flashing "loading…".
  async function loadProgress({ quiet = false } = {}) {
    if (widgets.size === 0) return;
    if (!quiet) for (const w of widgets.values()) setStatus(w, "loading…");
    try {
      const section = await api("GET", sectionPath());
      const byId = new Map((section?.exercises || []).map((x) => [x.exerciseId, x]));
      for (const [id, w] of widgets) showStored(w, byId.get(id));
      const orphans = [...byId.keys()].filter((id) => !widgets.has(id));
      if (orphans.length) console.info("[ipok] stored exercises not on this page:", orphans);
    } catch (e) {
      console.error("[ipok]", e);
      for (const w of widgets.values()) setStatus(w, `load failed: ${e.message}`, "err");
    }
  }

  async function save(w, exerciseData) {
    setStatus(w, "saving…");
    try {
      await api("PUT", `/api/Progress/${enc(cfg.courseInstance)}`, {
        moduleId: cfg.module, sectionId: cfg.section, exerciseId: w.id, exerciseData,
      });
      await loadProgress({ quiet: true });
    } catch (e) {
      console.error("[ipok]", e);
      setStatus(w, `save failed: ${e.message}`, "err");
    }
  }

  async function remove(w) {
    setStatus(w, "deleting…");
    try {
      await api("DELETE", `${sectionPath()}/exercises/${enc(w.id)}`);
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
    renderWidgets();
    if (account()) await loadProgress();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
