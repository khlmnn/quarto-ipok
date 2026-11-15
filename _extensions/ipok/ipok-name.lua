-- {{< ipok-name >}}: the signed-in user's name, filled in by ipok.js. An
-- optional argument is shown instead when signed out: {{< ipok-name "du" >}}.
-- With part="first", only the first name: {{< ipok-name part="first" >}}.

return {
  ["ipok-name"] = function(args, kwargs)
    local fallback = args[1] and pandoc.utils.stringify(args[1]) or ""
    local part = kwargs and kwargs["part"] and pandoc.utils.stringify(kwargs["part"]) or ""
    local attrs = {}
    if part == "first" then
      attrs["data-part"] = "first"
    elseif part ~= "" then
      -- Like fail() in ipok.lua: Quarto would turn error() into a warning.
      quarto.log.error("[ipok] " .. quarto.doc.input_file .. ": ipok-name: part must be \"first\", not \"" .. part .. "\"")
      os.exit(1)
    end
    return pandoc.Span(fallback, pandoc.Attr("", { "ipok-name" }, attrs))
  end,
}
