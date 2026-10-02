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

local SITE_KEYS = {
  { "client-id", "clientId" },
  { "tenant-id", "tenantId" },
  { "redirect-uri", "redirectUri" },
  { "api-base", "apiBase" },
  { "scope", "scope" },
  { "course-instance", "courseInstance" },
}

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
  return "0.1.0-" .. pandoc.utils.sha1(table.concat(parts)):sub(1, 8)
end

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

  local exercises = {}
  local seen = {}
  doc = doc:walk({
    Div = function(el)
      if not el.classes:includes("exercise") then return nil end
      local id = el.attributes["id"] or (el.identifier ~= "" and el.identifier or nil)
      if id == nil then fail("exercise div without an id") end
      if seen[id] then fail("duplicate exercise id '" .. id .. "'") end
      seen[id] = true
      table.insert(exercises, id)
      el.attributes["id"] = nil
      el.attributes["data-exercise-id"] = id
      return el
    end,
  })

  if #exercises > 0 and (config.module == nil or config.section == nil) then
    fail("page has exercises but no module-id / section-id metadata")
  end
  config.exercises = exercises

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
