-- IPOK Progress: Entra ID sign-in and progress persistence for Quarto HTML pages.
--
-- Site configuration (in _quarto.yml):
--   ipok:
--     client-id, tenant-id, redirect-uri, api-base, scope, course-instance
--     cooldown (optional; see the README, "Waiting after wrong answers")
-- Page metadata (top-level, since Quarto merges maps shallowly):
--   module-id: <moduleId>
--   section-id: <sectionId>
-- Exercises:
--   ::: {.exercise id="ex-1"}
--   :::
-- Checked questions (see the README, "Checked questions"):
--   ::: {.question id="q-1" type="number"}
--   How much is {{a}} + {{b}}?
--
--   ```{.variants}
--   [{"id": "v1", "a": 2, "b": 3, "answer": 5}]
--   ```
--   :::
-- Progress page (see the README, "Progress page"), optionally linked from the
-- navbar with the site option progress-page:
--   ::: {.ipok-progress}
--   :::

local VERSION = "0.9.0"

local SITE_KEYS = {
  { "client-id", "clientId" },
  { "tenant-id", "tenantId" },
  { "redirect-uri", "redirectUri" },
  { "api-base", "apiBase" },
  { "scope", "scope" },
  { "course-instance", "courseInstance" },
}

local QUESTION_TYPES = { mcq = true, number = true, text = true }
-- Variant fields with a meaning of their own; all others must be placeholders.
local RESERVED = { id = true, answer = true, options = true }
-- Fewer variants than this give a warning (a single variant does not).
local MIN_VARIANTS = { mcq = 3, number = 10, text = 10 }
local PLACEHOLDER = "{{([%a_][%w_]*)}}"
-- Module of the per-student seed record; no page may use it.
local RESERVED_MODULE = "_ipok"
-- The site's cooldown schedule (ipok.cooldown), the default for questions.
local site_cooldown = nil

local function str(v)
  if v == nil then return nil end
  local s = pandoc.utils.stringify(v)
  if s == "" then return nil end
  return s
end

local function fail(msg)
  quarto.log.error("[ipok] " .. quarto.doc.input_file .. ": " .. msg)
  os.exit(1)
end

local function warn(msg)
  quarto.log.warning("[ipok] " .. quarto.doc.input_file .. ": " .. msg)
end

-- The dependency is served from site_libs/quarto-contrib/ipok-<version>/.
-- Deriving the version from the files' content changes that URL whenever
-- they change, so browsers never run a cached older ipok.js (GitHub Pages
-- serves with max-age=600).
local function content_version()
  local parts = {}
  for _, name in ipairs({ "ipok.js", "ipok.css" }) do
    local f = assert(io.open(quarto.utils.resolve_path(name), "rb"))
    table.insert(parts, f:read("a"))
    f:close()
  end
  return VERSION .. "-" .. pandoc.utils.sha1(table.concat(parts)):sub(1, 8)
end

-- ---- Questions ----------------------------------------------------------

local function is_array(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  for i = 1, n do if t[i] == nil then return false end end
  return true
end

-- pandoc.json decodes every number as a float; 42.0 would be encoded back as
-- "42.0" and shown as such in the question text.
local function integers(v)
  if type(v) == "number" and math.type(v) == "float" and v == math.floor(v) and math.abs(v) < 2^53 then
    return math.tointeger(v)
  elseif type(v) == "table" then
    local out = {}
    for k, x in pairs(v) do out[k] = integers(x) end
    return out
  end
  return v
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local s = f:read("a")
  f:close()
  return s
end

local function decode_variants(text, where, qid)
  local ok, t = pcall(pandoc.json.decode, text, false)
  if not ok or type(t) ~= "table" then
    fail("question '" .. qid .. "': " .. where .. " is not valid JSON")
  end
  if not is_array(t) or #t == 0 then
    fail("question '" .. qid .. "': " .. where .. " must be a non-empty JSON array of variants")
  end
  return integers(t)
end

-- Every {{name}} in the text of `blocks` (including math, code and raw HTML).
local function placeholders(blocks)
  local names = {}
  local function scan(text)
    for name in text:gmatch(PLACEHOLDER) do names[name] = true end
  end
  pandoc.Div(blocks):walk({
    Inline = function(i) if i.text then scan(i.text) end end,
    Block = function(b) if b.text then scan(b.text) end end,
  })
  return names
end

local function scalar(v)
  return type(v) == "string" or type(v) == "number" or type(v) == "boolean"
end

local function check_variant(q, v, i, names)
  local where = "question '" .. q.id .. "', variant " .. i
  if type(v) ~= "table" or (is_array(v) and next(v) ~= nil) then fail(where .. " is not a JSON object") end
  if type(v.id) ~= "string" or v.id == "" then fail(where .. " has no string \"id\"") end
  where = "question '" .. q.id .. "', variant '" .. v.id .. "'"
  for name in pairs(names) do
    if v[name] == nil then fail(where .. " has no value for {{" .. name .. "}}") end
  end
  for key, value in pairs(v) do
    if not RESERVED[key] then
      if not names[key] then fail(where .. ": field \"" .. key .. "\" is not used as a placeholder") end
      if not scalar(value) then fail(where .. ": field \"" .. key .. "\" must be a string, number or boolean") end
    end
  end
  if q.type == "number" then
    if type(v.answer) ~= "number" then fail(where .. ": \"answer\" must be a number") end
  else
    if type(v.answer) ~= "string" or v.answer == "" then fail(where .. ": \"answer\" must be a non-empty string") end
  end
  if q.type == "mcq" then
    if not is_array(v.options) or #v.options < 2 then fail(where .. ": \"options\" must be a list of at least 2 strings") end
    local seen, hits = {}, 0
    for _, o in ipairs(v.options) do
      if type(o) ~= "string" or o == "" then fail(where .. ": every option must be a non-empty string") end
      if seen[o] then fail(where .. ": option '" .. o .. "' appears twice") end
      seen[o] = true
      if o == v.answer then hits = hits + 1 end
    end
    if hits ~= 1 then fail(where .. ": \"answer\" must be one of the options") end
  elseif v.options ~= nil then
    fail(where .. ": \"options\" is only allowed in mcq questions")
  end
end

local function number_attr(el, name, qid, integer)
  local s = el.attributes[name]
  if s == nil then return nil end
  local n = tonumber(s)
  if n == nil or n < 0 or (integer and math.type(n) ~= "integer") then
    fail("question '" .. qid .. "': " .. name .. "=\"" .. s .. "\" must be a non-negative " .. (integer and "integer" or "number"))
  end
  return n
end

-- A cooldown schedule: the seconds to wait after the 1st, 2nd, … wrong answer
-- to a question, the last value repeating. From "0, 10, 30" or a YAML list;
-- nil if every value is 0.
local function parse_cooldown(v, where)
  local items = {}
  if pandoc.utils.type(v) == "List" then
    for _, x in ipairs(v) do table.insert(items, str(x) or "") end
  else
    for part in (str(v) or ""):gmatch("[^,%s]+") do table.insert(items, part) end
  end
  if #items == 0 then fail(where .. ": cooldown is empty") end
  local waits, any = {}, false
  for _, item in ipairs(items) do
    local n = tonumber(item)
    if n == nil or n < 0 or math.type(n) ~= "integer" then
      fail(where .. ": cooldown value '" .. item .. "' must be a non-negative integer (seconds)")
    end
    if n > 0 then any = true end
    table.insert(waits, n)
  end
  return any and waits or nil
end

-- A quarto-live code cell: a {.pyodide} code block, or a div that holds one
-- (e.g. .line-numbers), or what quarto-live made of it if its filter ran first.
local function is_code_cell(b)
  if b.t == "CodeBlock" then return b.classes:includes("pyodide") end
  if b.t ~= "Div" then return false end
  local found = false
  b:walk({
    CodeBlock = function(c) if c.classes:includes("pyodide") then found = true end end,
    Div = function(d) if d.classes:includes("exercise-cell") then found = true end end,
  })
  return found
end

-- The exercise name quarto-live gave a code cell (ipok-pre.lua sets it to the
-- question id): from the code block's attribute, or from the cell's options
-- in quarto-live's <script type="pyodide-N-contents"> (base64 of JSON
-- {code, attr}) if quarto-live's filter ran first.
local function cell_exercise(cell)
  local name = nil
  cell:walk({
    CodeBlock = function(c) name = name or c.attributes["exercise"] end,
    RawBlock = function(r)
      local b64 = r.text:match('^<script type="pyodide%-%d+%-contents">%s*(.-)%s*</script>$')
      if b64 and not name then
        local ok, block = pcall(function() return pandoc.json.decode(quarto.base64.decode(b64), false) end)
        if ok and type(block) == "table" and type(block.attr) == "table" then name = block.attr.exercise end
      end
    end,
  })
  return name
end

-- Turns a .question div into the markup ipok.js fills in, and returns the
-- question's data for the page configuration.
local function question(el, id)
  local q = { id = id, type = el.attributes["type"] }
  if not QUESTION_TYPES[q.type or ""] then
    fail("question '" .. id .. "' needs type=\"mcq\", \"number\" or \"text\"")
  end

  -- The variants: a {.variants} code block inside the div, or a JSON file.
  -- An optional code cell after the text stays out of the template, so that
  -- it runs; ipok.js saves its code and output in the question's record.
  local inline, content, code = nil, pandoc.Blocks({}), nil
  for _, b in ipairs(el.content) do
    if b.t == "CodeBlock" and b.classes:includes("variants") then
      if inline then fail("question '" .. id .. "' has more than one {.variants} block") end
      inline = b.text
    elseif is_code_cell(b) then
      if code then fail("question '" .. id .. "' has more than one code cell") end
      code = b
    elseif code then
      fail("question '" .. id .. "': the code cell must come after the question text")
    else
      content:insert(b)
    end
  end
  local file = el.attributes["variants"]
  if inline and file then fail("question '" .. id .. "' has both a {.variants} block and variants=\"" .. file .. "\"") end
  if inline then
    q.variants = decode_variants(inline, "the {.variants} block", id)
  elseif file then
    local path = pandoc.path.join({ pandoc.path.directory(quarto.doc.input_file), file })
    local text = read_file(path)
    if not text then fail("question '" .. id .. "': cannot read variants file " .. file) end
    q.variants = decode_variants(text, file, id)
  else
    fail("question '" .. id .. "' has no {.variants} block and no variants=\"…\" file")
  end

  local names = placeholders(content)
  local ids = {}
  for i, v in ipairs(q.variants) do
    check_variant(q, v, i, names)
    if ids[v.id] then fail("question '" .. id .. "': variant id '" .. v.id .. "' appears twice") end
    ids[v.id] = true
  end
  local n = #q.variants
  if n > 1 and n < MIN_VARIANTS[q.type] then
    warn("question '" .. id .. "' has " .. n .. " variants; at least " .. MIN_VARIANTS[q.type] ..
      " are recommended for " .. q.type .. " questions")
  end

  if q.type == "number" then
    q.tolerance = number_attr(el, "tolerance", id, false)
    q.decimals = number_attr(el, "decimals", id, true)
    if q.tolerance and q.decimals then fail("question '" .. id .. "': use tolerance or decimals, not both") end
  elseif el.attributes["tolerance"] or el.attributes["decimals"] then
    fail("question '" .. id .. "': tolerance and decimals are only allowed in number questions")
  end
  if el.classes:includes("ignore-case") then
    if q.type ~= "text" then fail("question '" .. id .. "': ignore-case is only allowed in text questions") end
    q.ignoreCase = true
  end
  if el.attributes["cooldown"] then
    q.cooldown = parse_cooldown(el.attributes["cooldown"], "question '" .. id .. "'")
  else
    q.cooldown = site_cooldown
  end

  -- The question text goes into a <template>, which the browser keeps out of
  -- the page (and out of MathJax's first pass); ipok.js clones it, fills in
  -- the placeholders and typesets the result.
  content:insert(1, pandoc.RawBlock("html", '<template class="ipok-question-template">'))
  content:insert(pandoc.RawBlock("html", "</template>"))
  for _, k in ipairs({ "id", "type", "variants", "tolerance", "decimals", "cooldown" }) do
    el.attributes[k] = nil
  end
  el.identifier = ""
  el.attributes["data-question-id"] = id
  if code then
    -- It runs in an environment of its own (see ipok-pre.lua).
    if cell_exercise(code) ~= id then
      fail("question '" .. id .. "': the code cell is not a quarto-live exercise named '" .. id ..
        "' (is ipok-pre.lua missing from the extension, or does the cell set its own exercise option?)")
    end
    q.code = true
    content:insert(pandoc.Div({ code }, pandoc.Attr("", { "ipok-question-code" })))
  end
  el.content = content
  return el, q
end

-- ---- Progress page ------------------------------------------------------

-- The id of a div, from id="…" or #…, as for exercises and questions.
local function div_id(el)
  return el.attributes["id"] or (el.identifier ~= "" and el.identifier or nil)
end

-- Every .qmd file under `dir`, skipping files and folders whose names start
-- with "_" or "." (as Quarto does when rendering a project).
local function qmd_files(dir, out)
  local ok, names = pcall(pandoc.system.list_directory, dir)
  if not ok then return out end
  table.sort(names)
  for _, name in ipairs(names) do
    if not name:match("^[_.]") and name ~= "node_modules" then
      local path = pandoc.path.join({ dir, name })
      if name:match("%.qmd$") then
        table.insert(out, path)
      else
        qmd_files(path, out)
      end
    end
  end
  return out
end

-- The pages of the project with questions, for the progress table:
-- {title, href (relative to this page), module, section, questions = {ids}},
-- in the order of their paths.
local function progress_pages()
  local root = quarto.project.directory
  if root == nil then fail("a progress page (.ipok-progress) needs a Quarto project") end
  local here = pandoc.path.normalize(quarto.doc.input_file)
  local pages = {}
  for _, path in ipairs(qmd_files(root, {})) do
    local text = read_file(path)
    local ok, doc = pcall(pandoc.read, text or "", "markdown")
    if not ok then
      warn("progress page: cannot read " .. path .. ", skipped")
    elseif pandoc.path.normalize(path) ~= here then
      local ids = {}
      doc:walk({
        Div = function(el)
          if el.classes:includes("question") and div_id(el) then table.insert(ids, div_id(el)) end
        end,
      })
      if #ids > 0 then
        local module, section = str(doc.meta["module-id"]), str(doc.meta["section-id"])
        if module == nil or section == nil then
          warn("progress page: " .. path .. " has questions but no module-id / section-id, skipped")
        else
          local html = path:gsub("%.qmd$", ".html")
          table.insert(pages, {
            title = str(doc.meta.title) or pandoc.path.filename(path),
            href = pandoc.path.make_relative(html, pandoc.path.directory(here), true),
            module = module,
            section = section,
            questions = ids,
          })
        end
      end
    end
  end
  return pages
end

-- ---- Document -----------------------------------------------------------

function Pandoc(doc)
  if not quarto.doc.is_format("html") then return nil end

  local meta = doc.meta.ipok or {}
  local config = {}
  for _, key in ipairs(SITE_KEYS) do
    local value = str(meta[key[1]])
    if value == nil then fail("missing site option ipok." .. key[1]) end
    config[key[2]] = value
  end
  config.module = str(doc.meta["module-id"])
  config.section = str(doc.meta["section-id"])
  config.lang = str(doc.meta["lang"]) or "en"
  site_cooldown = meta["cooldown"] ~= nil and parse_cooldown(meta["cooldown"], "site option ipok.cooldown") or nil
  -- Optional: a page with an .ipok-progress div, relative to the site root;
  -- signed-in users get a link to it in the navbar.
  local progress_page = str(meta["progress-page"])
  if progress_page and quarto.project.offset then
    config.progressPage = quarto.project.offset .. "/" .. progress_page
  end
  if config.module == RESERVED_MODULE then fail("module-id '" .. RESERVED_MODULE .. "' is reserved for ipok") end

  local exercises, questions = {}, {}
  local seen = {}
  local function claim(id, what)
    if id == nil then fail(what .. " div without an id") end
    if seen[id] then fail("duplicate exercise or question id '" .. id .. "'") end
    seen[id] = true
  end
  doc = doc:walk({
    Div = function(el)
      if el.classes:includes("ipok-progress") then
        config.progress = config.progress or progress_pages()
        return nil
      end
      -- Hidden until ipok.js has checked whether the student has solved
      -- every question on the site (.ipok-gate) or not (.ipok-gate-closed).
      if el.classes:includes("ipok-gate") or el.classes:includes("ipok-gate-closed") then
        config.progress = config.progress or progress_pages()
        el.attributes["hidden"] = ""
        return el
      end
      local id = div_id(el)
      if el.classes:includes("question") then
        claim(id, "question")
        local div, q = question(el, id)
        table.insert(questions, q)
        return div
      end
      if not el.classes:includes("exercise") then return nil end
      claim(id, "exercise")
      table.insert(exercises, id)
      el.attributes["id"] = nil
      el.attributes["data-exercise-id"] = id
      return el
    end,
  })

  if (#exercises > 0 or #questions > 0) and (config.module == nil or config.section == nil) then
    fail("page has exercises or questions but no module-id / section-id metadata")
  end
  config.exercises = exercises
  config.questions = questions

  -- Escape "</" so the JSON cannot terminate the script element early.
  local json = quarto.json.encode(config):gsub("</", "<\\/")
  quarto.doc.include_text("in-header",
    '<script id="ipok-config" type="application/json">' .. json .. '</script>')
  quarto.doc.add_html_dependency({
    name = "ipok",
    version = content_version(),
    scripts = { "msal-browser.min.js", "ipok.js" },
    stylesheets = { "ipok.css" },
  })
  return doc
end
