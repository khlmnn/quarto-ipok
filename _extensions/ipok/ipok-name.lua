-- {{< ipok-name >}}: the signed-in user's name, filled in by ipok.js. An
-- optional argument is shown instead when signed out: {{< ipok-name "du" >}}.

return {
  ["ipok-name"] = function(args)
    local fallback = args[1] and pandoc.utils.stringify(args[1]) or ""
    return pandoc.Span(fallback, { class = "ipok-name" })
  end,
}
