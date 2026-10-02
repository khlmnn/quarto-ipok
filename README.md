# quarto-ipok

A Quarto extension that lets students sign in with Entra ID (Azure AD) and saves their
work on exercises to the IPOK Progress API, so it is restored the next time they open the
page.

- **Sign-in:** a Sign in / Sign out button in the navbar (MSAL.js, redirect flow).
- **Code exercises:** for exercises containing a [quarto-live](https://github.com/r-wasm/quarto-live)
  Pyodide cell, the code and its output are saved when the student presses **Run Code**,
  and both are restored on the next visit, as if the cell had been run.
- **Plain exercises:** other exercises get a text box with a save button; this is mainly
  for testing the API.

Used by the ETE335 test site, https://liu-nlp.ai/ete335-test/
([source](https://github.com/liu-nlp/ete335-test)).

## Prerequisites

- An Entra ID app registration of type **Single-page application** whose redirect URIs
  include the site's root URL (e.g. `https://liu-nlp.ai/ete335-test/`), with delegated
  permission for the Progress API scope.
- The site's origin (e.g. `https://liu-nlp.ai`) allowed for CORS on the Progress API.
  For the IPOK test API this is Azure App Service's CORS setting, not only the app's
  `AllowedOrigins`.
- For code exercises: quarto-live. With PyTorch / Pyodide 314, use the fork
  [`khlmnn/quarto-live`](https://github.com/khlmnn/quarto-live)
  (`quarto add khlmnn/quarto-live@v0.2.0-dev.khlmnn.1`); stock quarto-live works with its
  default Pyodide.

## Installation

```bash
quarto add khlmnn/quarto-ipok
```

This installs the extension into `_extensions/khlmnn/ipok/`. Commit that folder with your
site; building the site does not download anything. Update with
`quarto update extension khlmnn/quarto-ipok`.

## Configuration

Site-wide settings in `_quarto.yml`:

```yaml
filters:
  - ipok

ipok:
  client-id: c6b6983e-0fcd-4337-82e8-5b7391841773
  tenant-id: 913f18ec-7f26-4c5f-a816-784fe9a58edd
  redirect-uri: https://liu-nlp.ai/ete335-test/   # registered SPA redirect URI; all pages share it
  api-base: https://ipok-progress-api-test-swe-wa.azurewebsites.net
  scope: https://liuonline.onmicrosoft.com/ida-spacy-progress-api-test-ar/user_impersonation
  course-instance: ete335-quarto-test
```

| Key | Meaning |
|---|---|
| `client-id`, `tenant-id` | the SPA app registration and its tenant |
| `redirect-uri` | the site root; MSAL returns the student to the page they started from |
| `api-base` | base URL of the Progress API |
| `scope` | the Progress API scope to request a token for |
| `course-instance` | the API's `courseInstanceId`, i.e. the namespace for this site's data |

Client and tenant IDs are public identifiers, not secrets. Login only works at the
registered redirect URI, so it does not work under `quarto preview` on `localhost`
unless that URL is registered (and allowed for CORS) as well.

## Pages and exercises

Each page with exercises sets the module and section, as **top-level** keys. (Quarto
merges site and page metadata shallowly for keys like `ipok`, so a page-level `ipok:` map
would replace the site settings.)

````markdown
---
title: Tensors
module-id: introduction-to-pytorch
section-id: tutorial
---

::: {.exercise id="task-1"}
Create a tensor of zeros with the same shape as `Q`.

```{.pyodide}
# Your code here
```
:::
````

An exercise is a fenced div with class `exercise` and an `id`. Data is stored per
`(course-instance, module-id, section-id, id)`, so ids only need to be unique within a page.
The build fails if an exercise has no `id`, an `id` is repeated on a page, or a page has
exercises but no `module-id` / `section-id`.

An exercise that contains a quarto-live Pyodide cell is a **code exercise** (the page
needs `format: live-html`). Everything else is a **plain exercise**.

### Code exercises

- Saved when the student presses **Run Code** (or Ctrl/Cmd-Enter), once the run has
  finished. "Start Over" is not saved.
- On the next visit, saved code is put back into the editor, and saved output is shown
  below it with quarto-live's own markup, as if the cell had been run. It appears before
  Pyodide has loaded, and is replaced by real output on the next Run. Start Over and
  **Delete saved** clear it.
- Python's state is not restored: cells that depend on earlier cells need those to be run
  again.
- Only the first Pyodide cell in an exercise is saved.

Stored `exerciseData`:

```json
{"code": "<editor text, or null if unchanged from the page>",
 "output": [{"kind": "stdout", "text": "…"},
            {"kind": "image", "src": "data:image/png;base64,…", "width": 933}]}
```

`kind` is `stdout`, `stderr` (Python errors land here, message only), `display` (value of
the last expression), `html` (HTML output, stored as its text only) or `image` (plots,
as a PNG/JPEG/GIF data URL with the displayed width; `src` is omitted above 500,000
characters). Restored output is built from text and validated image URLs only, never from
stored markup.

### Plain exercises

A text box pre-filled with sample JSON, a **Save (PUT)** and a **Delete** button, and the
stored data. `exerciseData` is the text box content as is.

## Notes

- **Token storage.** MSAL keeps its cache in `sessionStorage` (per tab, cleared when it
  is closed). quarto-live renders HTML output from Python on the page and runs scripts in
  it, so student code (or course content) can run JavaScript next to that cache. The
  Progress API only lets a token act on its own user's data.
- **Caching.** The dependency folder is named after a hash of `ipok.js` and `ipok.css`
  (`ipok-0.1.0-<hash>`), so browsers never keep running an old script after an update,
  even on hosts that cache files (GitHub Pages: 10 minutes).
- **Filter order** with quarto-live doesn't matter.

## What ipok relies on in quarto-live

Code exercises use undocumented quarto-live internals. Check these after any quarto-live
update (the fork's [`FORK.md`](https://github.com/khlmnn/quarto-live/blob/main/FORK.md) has
the full checklist).

| # | Dependency | Used for | Where in quarto-live |
|---|---|---|---|
| D1 | Each `{.pyodide}` cell renders as `<div id="pyodide-N" class="exercise-cell">` followed by `<script type="pyodide-N-contents">` (base64 of UTF-8 JSON `{code, attr}`), both inside the author's `.exercise` div | finding the cell of an exercise; reading the cell's initial code to detect "unchanged" | `live.lua`, `PyodideCodeBlock` |
| D2 | Run (button and Ctrl/Cmd-Enter) dispatches a non-bubbling `CustomEvent("input", {detail: {commit: true}})` on the editor container; Start Over dispatches the same with an explicit `detail.code` | detecting Run (capture listener on `document`); telling Start Over apart | `editor.ts`: `render()`, `languageExtensions()` |
| D3 | quarto-live's own `onInput` sets `container.value.code` to the editor text in response to that event | reading the code that was run (one tick after the event) | `editor.ts`: `onInput()` |
| D4 | Each evaluation renders a **new** `.cell-output-container` element inside `#pyodide-N`, inserted once evaluation is complete | knowing when a run has finished and its output is complete | `evaluate-pyodide.ts` `newContainer()`, OJS template `pyodide-editor.ojs` |
| D5 | Output markup: `div.cell-output-stdout` / `div.cell-output-stderr` (`pre > code`), `div.cell-output` (`pre > code`, last-expression value, or arbitrary HTML), `div.cell-output-display` (`img` or `canvas` for plots); errors go to stderr | reading output to save; rebuilding saved output with the same markup | `evaluate-pyodide.ts` |
| D6 | The OJS output slot in `#pyodide-N` is replaced when Pyodide has loaded; content appended *after* it survives | placing restored output so it appears immediately and survives the load | Quarto OJS runtime + `pyodide-editor.ojs` |
| D7 | The editor is CodeMirror 6; the `EditorView` is reachable from `.cm-content` via `cmView.rootView.view` (older 6.x) or `cmTile.root.view` (newer 6.x) | writing saved code into the editor | bundled `@codemirror/view` (`EditorView.findFromDOM`) |
| D8 | Pages need `format: live-html`; cells use ```` ```{.pyodide} ```` (not `{pyodide}`, which triggers Jupyter at render time) | authoring | Quarto + `live.lua` |
| D9 | `ipok` and `live` filters are independent of order: `ipok` only adds `data-exercise-id` to `.exercise` divs and keeps their content | filter setup | — |

## Tested with

| | |
|---|---|
| Quarto | 1.10.18 |
| quarto-live | fork `khlmnn/quarto-live` `v0.2.0-dev.khlmnn.1` (upstream `12fb30a` plus Pyodide 314.0.2 pin and button keydown fix) |
| Pyodide | 314.0.2 (with `pyodide-pytorch` 2.13.0) |
| MSAL.js | 4.13.2 (`@azure/msal-browser`, bundled; MIT, see `_extensions/ipok/msal-browser.LICENSE`) |
| Browsers | Chromium (headless, scripted tests); Safari (used manually on the deployed test site) |

## License

MIT, see [`LICENSE`](LICENSE). The bundled MSAL.js (`_extensions/ipok/msal-browser.min.js`) is
© Microsoft Corporation, also MIT; see `_extensions/ipok/msal-browser.LICENSE`.
