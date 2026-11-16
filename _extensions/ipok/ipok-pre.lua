-- IPOK Progress, run before quarto-live's filter (at: pre-ast): the code cell
-- of a checked question runs in an environment of its own. Every
-- ```{.pyodide} block inside a .question div becomes a quarto-live exercise
-- named after the question (attribute exercise="<question id>"), which
-- quarto-live evaluates in a fresh namespace on every Run, apart from the
-- page's shared one. Its caption stays that of an ordinary cell.

-- quarto-live's default captions for Python cells (live.labels.caption-python
-- overrides them, as in quarto-live).
local CAPTION = { en = "Python Code", sv = "Python-kod" }

local function str(v)
  if v == nil then return nil end
  local s = pandoc.utils.stringify(v)
  if s == "" then return nil end
  return s
end

function Pandoc(doc)
  if not quarto.doc.is_format("html") then return nil end
  local labels = doc.meta.live and doc.meta.live.labels
  local lang = (str(doc.meta.lang) or "en"):sub(1, 2)
  local caption = str(labels and labels["caption-python"]) or CAPTION[lang] or CAPTION.en

  return doc:walk({
    Div = function(el)
      if not el.classes:includes("question") then return nil end
      local id = el.attributes["id"] or (el.identifier ~= "" and el.identifier or nil)
      if id == nil then return nil end -- ipok.lua reports it
      return el:walk({
        CodeBlock = function(b)
          if not b.classes:includes("pyodide") then return nil end
          b.attributes["exercise"] = b.attributes["exercise"] or id
          b.attributes["caption"] = b.attributes["caption"] or caption
          return b
        end,
      })
    end,
  })
end
