-- IPOK Progress: Entra ID sign-in and progress persistence for Quarto HTML pages.
--
-- Site configuration (in _quarto.yml):
--   ipok:
--     client-id, tenant-id, redirect-uri, api-base, scope, course-instance
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

local VERSION = "0.2.0"

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

-- Turns a .question div into the markup ipok.js fills in, and returns the
-- question's data for the page configuration.
local function question(el, id)
  local q = { id = id, type = el.attributes["type"] }
  if not QUESTION_TYPES[q.type or ""] then
    fail("question '" .. id .. "' needs type=\"mcq\", \"number\" or \"text\"")
  end

  -- The variants: a {.variants} code block inside the div, or a JSON file.
  local inline, content = nil, pandoc.Blocks({})
  for _, b in ipairs(el.content) do
    if b.t == "CodeBlock" and b.classes:includes("variants") then
      if inline then fail("question '" .. id .. "' has more than one {.variants} block") end
      inline = b.text
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

  -- The question text goes into a <template>, which the browser keeps out of
  -- the page (and out of MathJax's first pass); ipok.js clones it, fills in
  -- the placeholders and typesets the result.
  content:insert(1, pandoc.RawBlock("html", '<template class="ipok-question-template">'))
  content:insert(pandoc.RawBlock("html", "</template>"))
  for _, k in ipairs({ "id", "type", "variants", "tolerance", "decimals" }) do
    el.attributes[k] = nil
  end
  el.identifier = ""
  el.attributes["data-question-id"] = id
  el.content = content
  return el, q
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
      local id = el.attributes["id"] or (el.identifier ~= "" and el.identifier or nil)
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
