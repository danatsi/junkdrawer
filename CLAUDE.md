@AGENTS.md

# Browser checks

For anything visual — verifying a layout, a hover state, an OG image, or the
capture flow end to end — drive a real browser with the `agent-browser` CLI
rather than reasoning from the CSS. Run `agent-browser skills get core --full`
first; it ships version-matched guidance and a `dogfood` skill for exploratory
passes. Pairs with the `/run` skill for starting the dev server.

This lives here and not in AGENTS.md because `next dev` regenerates that file.
