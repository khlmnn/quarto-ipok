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
- **Checked questions:** multiple-choice, number and text questions, checked in the
  browser, whose variant (numbers, options, data slice) depends on a per-student seed,
  optionally with an isolated code cell that is saved with the answers.
- **Progress page:** a table of the site's pages with questions and how many of them
  the student has solved, linked from the navbar when signed in.

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
  (`quarto add khlmnn/quarto-live@v0.2.0-dev.khlmnn.3`); stock quarto-live works with its
  default Pyodide, except that a solved question's code cell is not locked.

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
  progress-page: min-sida.html   # optional
  cooldown: [0, 10, 30, 60, 120]  # optional
```

| Key | Meaning |
|---|---|
| `client-id`, `tenant-id` | the SPA app registration and its tenant |
| `redirect-uri` | the site root; MSAL returns the student to the page they started from |
| `api-base` | base URL of the Progress API |
| `scope` | the Progress API scope to request a token for |
| `course-instance` | the API's `courseInstanceId`, i.e. the namespace for this site's data |
| `progress-page` | optional: the [progress page](#progress-page), relative to the site root; signed-in users get a link to it in the navbar |
| `cooldown` | optional: the default [wait after wrong answers](#waiting-after-wrong-answers) for checked questions |

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
  finished, and on **Start Over** (as the page's code without output). Runs started by a
  later cell's "Run All Above" (in the `khlmnn/quarto-live` fork) are not saved.
- Saving is silent: ipok adds nothing to the cell, except a message when saving or loading
  fails. Signed out, nothing is saved; tell students on the page to sign in first.
- On the next visit, saved code is put back into the editor, and saved output is shown
  below it with quarto-live's own markup, as if the cell had been run. It appears before
  Pyodide has loaded, and is replaced by real output on the next Run. Start Over clears
  it.
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

## Checked questions

A question is a fenced div with class `question`, an `id` and a `type`: `mcq`
(multiple choice, one right option), `number` or `text`. It holds the question text and
a table of **variants**; which variant a student sees depends on a per-student seed, so
that students cannot copy answers from each other. Answers are checked in the browser.

````markdown
::: {.question id="q-sum" type="number"}
Hur mycket är {{a}} + {{b}}? Som formel: $\frac{{{a}}}{2}$.

```{.variants}
[
  {"id": "v01", "a": 2, "b": 3, "answer": 5},
  {"id": "v02", "a": 4, "b": 5, "answer": 9}
]
```
:::

::: {.question id="q-larger" type="mcq"}
Vilket tal är störst?

```{.variants}
[{"id": "v01", "options": ["1", "2", "3"], "answer": "3"},
 {"id": "v02", "options": ["\\(\\frac{1}{2}\\)", "\\(\\frac{1}{3}\\)"], "answer": "\\(\\frac{1}{2}\\)"}]
```
:::

::: {.question id="q-count" type="number" variants="q-count.json"}
Hur många berättelser i del {{part}} handlar om {{character}}?
:::
````

### Variants

- The table is a JSON array, either in a `{.variants}` code block inside the div or in a
  file named by `variants="…"` (relative to the page). JSON rather than YAML, because
  Pandoc reads YAML values as Markdown (`a*b*c` would become `abc`), and Quarto's Lua has
  no other YAML parser.
- Each variant is an object with a unique string `id`, an `answer`, and one value for
  each placeholder. An `mcq` variant also has `options`, a list of strings of which
  `answer` is one; they are shown in an order shuffled per student and attempt.
- `{{name}}` in the question text is replaced by the variant's value for `name`, as plain
  text, also inside math and code. Values are strings, numbers or booleans; numbers are
  shown as JSON writes them (`2.5`), so give a string (`"2,5"`) for Swedish formatting.
  Option texts may contain math as `\(…\)`.
- Answers: a number for `number` questions, a string otherwise.

The build fails on invalid JSON, a missing or duplicate variant id, a placeholder without
a value in some variant, a variant field that is not a placeholder (apart from `id`,
`answer`, `options`), a wrong answer type, an `mcq` answer that is not among the options,
or a question id that is also used by an exercise or question on the same page. It warns
when an `mcq` question has fewer than 3 variants or a `number`/`text` question fewer than
10; a question with a single variant is a plain fixed question and gives no warning.

### Checking

| Type | Accepted |
|---|---|
| `number` | `,` or `.` as decimal separator, spaces anywhere (`1 000`); compared exactly with `answer`. `tolerance="0.01"` accepts answers within that distance; `decimals="2"` rounds both sides to 2 decimals first, half away from zero on the digits as written (0.045 → 0.05, as by hand). |
| `text` | leading, trailing and repeated whitespace ignored, Unicode NFC; case-sensitive unless the div has class `.ignore-case`. |
| `mcq` | the chosen option. |

Input that is not an answer (empty, or not a number) gives a hint and does not count as an
attempt. Answers are never revealed. A solved question stays solved and is shown
read-only with the student's answer and, when signed in, the time it was answered
("Rätt besvarad 19 nov. 2026 14:32"). Attempts are unlimited, but may have to wait
(see the next section).

### Waiting after wrong answers

A cooldown schedule makes a student wait after wrong answers, so that guessing many
similar answers, or clicking through `mcq` variants, takes time:

```yaml
ipok:
  cooldown: [0, 10, 30, 60, 120]   # site default; also "0, 10, 30, 60, 120"
```

```markdown
::: {.question id="q-count" type="number" variants="q-count.json" cooldown="0, 30"}
```

- The values are the seconds to wait after the 1st, 2nd, … wrong answer to the
  question; the last value repeats. Above, the first wrong answer has no wait (a typo),
  the second 10 s, the fifth and every later one 2 min.
- A question's `cooldown="…"` replaces the site default; `cooldown="0"` turns it off.
  Without either, there is no wait.
- While waiting, "Svara" (for `number` and `text`) or "Ny fråga" (after a wrong `mcq`
  answer) is disabled and the status line counts down ("Fel, försök igen om 25 s.").
- The wait runs from the time of the last answer (`at` in the record), so it survives a
  reload when signed in. Signed out, nothing survives a reload anyway. Answers saved
  without a time (before ipok 0.9) have no wait.
- **It only slows students down.** Answers are checked in the browser: the variant
  tables, answers included, are part of the page, and the times come from the
  browser's clock. A student who opens the developer tools gets around it. The times
  in the records (and the API's history of them) show who answered how fast.

### Which variant

- Every student has a **seed**, an integer 0 … 2³²−1. For each question, the variants are
  ordered by a hash of (seed, question id, variant id); adding a variant to a table
  changes only the students whose order it lands in front of.
- A `number` or `text` question always shows the first variant in that order, so a
  student who fixes their code keeps working on their own data.
- An `mcq` question shows variant *k* mod *n* after *k* wrong answers: a wrong answer
  shows "Fel." and a "Ny fråga" button, and the next variant cannot be guessed through
  the options.
- The variant is recomputed from the seed each time; the saved record only notes it.

### A code cell in a question

A question may end with one quarto-live code cell (```` ```{.pyodide} ````, also inside a
div such as `.line-numbers`), for the code the student writes to find the answer:

````markdown
::: {.question id="q-count" type="number" variants="q-count.json"}
Hur många berättelser i del {{part}} handlar om {{character}}?

```{.pyodide}
stories = load_stories(part=...)  # skriv in delens nummer
```
:::
````

- The cell is shown between the question text and the answer field. Text after the cell
  is an error.
- It is **isolated**: it runs in a fresh Python namespace on every Run, not in the page's
  shared one, so it sees nothing that other cells define, and other cells see nothing of
  it. It must import what it needs itself. (The filter `ipok-pre.lua`, which runs before
  quarto-live's, makes it a quarto-live exercise named after the question, with the
  caption of an ordinary cell; a cell must not set `exercise` itself. "Run All Above"
  skips it and is not shown on it.)
- Its code and output are saved **in the question's record** (see "Stored data"): on
  Run, on Start Over, and with every answer. They are restored like a code exercise's.
- Once the question is solved, the cell is **locked**: read-only, with Run Code and Start
  Over disabled (quarto-live fork, `live-lock`), and a note says so.
- It is not a template: `{{placeholders}}` in it are not filled in. Values the student
  needs, such as a data slice, are in the question text, and the student types them in.

### Stored data

Each question is an ordinary record, under `(course-instance, module-id, section-id, id)`,
written on every attempt (so the API's shadow table keeps the history):

```json
{"attempt": 1, "variant": "v03", "solved": true,
 "answers": [{"variant": "v02", "answer": "4", "correct": false, "at": "2026-11-19T13:31:02.417Z"},
             {"variant": "v03", "answer": "6", "correct": true, "at": "2026-11-19T13:32:40.105Z"}]}
```

`at` is the time of the answer (ISO 8601, UTC) from the browser's clock, which the
student can set; it is for display and the cooldown, not for deadlines. The record's
`Completed` in the database is no substitute: the backend sets it only when the record
is created, without a time zone.

A question with a code cell also stores the cell's `code` and `output` (as for a code
exercise: `code` is `null` while it is the page's code), written on Run and Start Over
as well, and each answer keeps the `code` that was in the cell when it was given:

```json
{"attempt": 0, "variant": "v03", "solved": true,
 "answers": [{"variant": "v03", "answer": "6", "correct": true, "at": "…", "code": "stories = …"}],
 "code": "stories = …", "output": [{"kind": "stdout", "text": "6\n"}]}
```

The seed is the record `(course-instance, "_ipok", "_ipok", "seed")` = `{"seed": <n>}`.
At a student's first sign-in it is created as the first 4 bytes (big-endian) of
SHA-256(`<course-instance>:<localAccountId>`), so two tabs creating it at the same time
write the same value. `module-id: _ipok` is therefore reserved.

Signed-out visitors can answer questions with a random seed kept in `localStorage`;
nothing is saved, and the questions say "Logga in för att spara dina svar". After
signing in they see the variants of their stored seed.

Interface texts follow the page's `lang` (Swedish and English built in, English
otherwise).

### Debug panel

Add `?ipok-debug` to a page's URL. The panel is shown to signed-in users whose access
token has the `Teacher` role, and to anyone signed out on `localhost` (`quarto preview`,
where sign-in does not work; only the local seed is involved there).

- **Seed:** the current seed. *Läs* reads it from the database, *Spara* writes the
  field's value, *Återställ härledd* writes the seed derived from the account (signed
  out: *Ny slumpad*, a new random local seed). Changing the seed shows the new variants
  at once.
- **Per question:** the variant id and its place in the student's order, the attempt
  count, whether it is solved, and the right answer. *Nästa variant* moves an `mcq`
  question on by one attempt (saved); for `number` and `text` questions, whose variant
  does not depend on the attempt, it is a local offset that is not saved. *Återställ*
  deletes the question's record.
- **Visa alla varianter** lists every question's table in the student's order, to
  proof-read generated tables.

## Progress page

A page with an `ipok-progress` div shows signed-in students their progress on checked
questions:

```markdown
---
title: Min sida
---

::: {.ipok-progress}
:::
```

The div gets a table with one row per page that has questions: the page's title as a
link, and *x* / *y*, where *y* is the number of questions on the page and *x* the number
of them the student has solved; a last row gives the totals. Records of questions that
are no longer on a page do not count. Signed-out visitors see "Logga in för att se dina
framsteg." Name the page in the site option `progress-page` to give signed-in users a
"Min sida" link in the navbar; the page itself is not hidden, as nothing on a static site
is.

- **Which pages.** When the progress page is rendered, the filter reads every `.qmd`
  file in the project, except in files and folders whose names start with `_` or `.`, and
  lists those with `.question` divs, in the order of their paths. It takes `title`,
  `module-id` and `section-id` from each file's own front matter (not from
  `_metadata.yml`) and does not follow includes. Pages with questions but without
  `module-id` / `section-id` are skipped with a warning.
- **Rendering.** The list is made when the progress page is rendered, so a full
  `quarto render` keeps it up to date. Rendering a single page, e.g. under `quarto
  preview`, does not update the progress page.
- **Requests.** One `GET` per section, all at the same time; a section that cannot be
  loaded is marked in its row, and the others are still shown.

### Gate

An `ipok-gate` div is shown only to a signed-in student who has solved every question on
the site, for example to link to the registration for an exam; an `ipok-gate-closed` div
only to a signed-in student who has not:

```markdown
::: {.ipok-gate}
Du har besvarat alla kontrollfrågor rätt. [Anmäl dig till examinationen](https://…).
:::

::: {.ipok-gate-closed}
När du har besvarat alla kontrollfrågor rätt kan du anmäla dig till examinationen här.
:::
```

Both are rendered with the `hidden` attribute. Once all sections have loaded, the gate is
shown if *x* = *y* in the total row and the site has questions, and the closed gate
otherwise. Signed out, or if a section cannot be loaded, both stay hidden. They work with
or without an `ipok-progress` div on the same page, and count the same pages and
questions. Like everything on a static site, the content is in
the page's HTML and can be read in its source: the gate keeps students from following a
link before they are done, but it is not access control, and whoever receives the
registrations should check them against the stored progress.

## Name

The shortcode `{{< ipok-name >}}` shows the signed-in user's name (the display name from
Entra ID, e.g. "Anna Andersson"), on any page and inside text: `Hej, {{< ipok-name >}}!`.
Signed out, it shows nothing, or its argument: `{{< ipok-name "du" >}}`. It renders as a
`<span class="ipok-name">`, so `[du]{.ipok-name}` works too.

With `part="first"`, it shows only the first name: `Hej, {{< ipok-name "du" part="first"
>}}!`. That is the `given_name` claim of the ID token if the app registration includes it
as an optional claim; otherwise the first word of the display name, or for "Andersson,
Anna" the first word after the comma.

## Notes

- **Token storage.** MSAL keeps its cache in `sessionStorage` (per tab, cleared when it
  is closed). quarto-live renders HTML output from Python on the page and runs scripts in
  it, so student code (or course content) can run JavaScript next to that cache. The
  Progress API only lets a token act on its own user's data.
- **Caching.** The dependency folder is named after a hash of `ipok.js` and `ipok.css`
  (`ipok-<version>-<hash>`), so browsers never keep running an old script after an update,
  even on hosts that cache files (GitHub Pages: 10 minutes).
- **Filter order.** `ipok-pre.lua` runs at `pre-ast`, before quarto-live's filter, and
  only adds options to the code cells of questions; `ipok.lua` works before or after
  quarto-live's filter.

## What ipok relies on in quarto-live

Code exercises use undocumented quarto-live internals. Check these after any quarto-live
update (the fork's [`FORK.md`](https://github.com/khlmnn/quarto-live/blob/main/FORK.md) has
the full checklist).

| # | Dependency | Used for | Where in quarto-live |
|---|---|---|---|
| D1 | Each `{.pyodide}` cell renders as `<div id="pyodide-N" class="exercise-cell">` followed by `<script type="pyodide-N-contents">` (base64 of UTF-8 JSON `{code, attr}`), both inside the author's `.exercise` or `.question` div | finding the cell of an exercise or question; reading the cell's initial code to detect "unchanged"; checking that a question's cell is an exercise (`attr.exercise`) | `live.lua`, `PyodideCodeBlock` |
| D2 | Run (button and Ctrl/Cmd-Enter) dispatches a non-bubbling `CustomEvent("input", {detail: {commit: true}})` on the editor container; Start Over dispatches the same with an explicit `detail.code`; Run All Above (fork) runs each cell above with `detail.runAbove: true` | detecting Run (capture listener on `document`); telling Start Over and Run All Above apart | `editor.ts`: `render()`, `languageExtensions()` |
| D3 | quarto-live's own `onInput` sets `container.value.code` to the editor text in response to that event | reading the code that was run (one tick after the event) | `editor.ts`: `onInput()` |
| D4 | Each evaluation renders a **new** `.cell-output-container` element inside `#pyodide-N`, inserted once evaluation is complete | knowing when a run has finished and its output is complete | `evaluate-pyodide.ts` `newContainer()`, OJS template `pyodide-editor.ojs` |
| D5 | Output markup: `div.cell-output-stdout` / `div.cell-output-stderr` (`pre > code`), `div.cell-output` (`pre > code`, last-expression value, or arbitrary HTML), `div.cell-output-display` (`img` or `canvas` for plots); errors go to stderr | reading output to save; rebuilding saved output with the same markup | `evaluate-pyodide.ts` |
| D6 | The OJS output slot in `#pyodide-N` is replaced when Pyodide has loaded; content appended *after* it survives | placing restored output so it appears immediately and survives the load | Quarto OJS runtime + `pyodide-editor.ojs` |
| D7 | The editor is CodeMirror 6; the `EditorView` is reachable from `.cm-content` via `cmView.rootView.view` (older 6.x) or `cmTile.root.view` (newer 6.x) | writing saved code into the editor | bundled `@codemirror/view` (`EditorView.findFromDOM`) |
| D8 | Pages need `format: live-html`; cells use ```` ```{.pyodide} ```` (not `{pyodide}`, which triggers Jupyter at render time) | authoring | Quarto + `live.lua` |
| D9 | `ipok.lua` is independent of filter order: it only adds `data-exercise-id` to `.exercise` divs and moves a question's cell; `ipok-pre.lua` (`at: pre-ast`) runs before `live.lua`, which reads cell options from code block attributes as well as `#|` lines | filter setup | `live.lua`, `ParseBlock` |
| D10 | A cell with `exercise: <name>` (and no `envir`) is evaluated in the environment `exercise-env-<name>`, rebuilt from scratch on every Run (with no setup block: empty), with the same output markup and editor container as other cells (D1–D7); Run All Above only runs cells of the same environment | isolating a question's cell | `pyodide-exercise.ojs`, `environment.ts` (`EnvironmentManager`), `editor.ts` (`cellsAbove`) |
| D11 | (fork) `CustomEvent("live-lock", {detail: {locked}})` on the editor container (the parent of `.exercise-editor`) makes the editor read-only and disables Run Code, Run All Above and Start Over | locking a solved question's cell | `editor.ts`: `setLocked()` |

## Tested with

| | |
|---|---|
| Quarto | 1.10.18; checked questions: 1.10.19 (Pandoc 3.10) |
| quarto-live | fork `khlmnn/quarto-live` `v0.2.0-dev.khlmnn.3` (upstream `12fb30a` plus the fork's changes in its `FORK.md`; `live-lock` needs `.3`) |
| Pyodide | 314.0.2 (with `pyodide-pytorch` 2.13.0) |
| MSAL.js | 4.13.2 (`@azure/msal-browser`, bundled; MIT, see `_extensions/ipok/msal-browser.LICENSE`) |
| Browsers | Chromium (headless, scripted tests); Safari (used manually on the deployed test site) |

## Tests

`tests/run.mjs` renders the fixture site `tests/site/` with the current extension, serves
it with a mock Progress API, and drives it in headless Chromium (Playwright), signed out
and, with a stand-in for MSAL, signed in as a student and as a teacher, including the
progress page. It also checks the filter's build errors.

```bash
cd tests && npm install && npm test   # or: node run.mjs errors
```

The Playwright version is pinned to one whose Chromium is installed
(`npx playwright install chromium` otherwise).

`tests/check-site.mjs` checks the questions of any rendered site that uses ipok, e.g. a
course site after new variant tables: it serves the site's `_site/` on localhost, opens
every page with questions with `?ipok-debug` (signed out, so nothing is saved), enters the
debug panel's answer for every variant of every question and expects it to be accepted,
and fails on unfilled placeholders and console errors. It checks that tables, rendering
and checking fit together, not that the answers themselves are right.

```bash
cd tests && node check-site.mjs ../../ete335 [page.html …] [--screenshots <dir>]
```

## License

MIT, see [`LICENSE`](LICENSE). The bundled MSAL.js (`_extensions/ipok/msal-browser.min.js`) is
© Microsoft Corporation, also MIT; see `_extensions/ipok/msal-browser.LICENSE`.
