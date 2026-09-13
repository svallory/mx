---
title: "Divergences and MX 2"
description: "Divergences from Marko and the MX 2 deferred list."
---

# Divergences from Marko

MX 1.0 is a strict subset of Marko syntax. Every MX 1.0 file is a valid Marko file with the same meaning for the structural core, and hosts may only *forbid* a tag they cannot honor, never add syntax, attribute forms, or file conventions Marko's parser and language server would reject. Divergence from Marko is permitted only from MX 2 on, and only deliberately: each divergence gets a line below, and a divergence that changes syntax lands only together with the tooling it breaks (grammar, Prettier, language server).

## Recorded divergences

*(none yet — MX 1.0 has no deliberate divergences)*

## Deferred to MX 2

| Construct | Why it was wanted | Marko verdict |
|---|---|---|
| Tag params on `<if>` (`<if|u|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` |
| Tag params on native elements (`<div|x|>`) | A uniform "tag params make children a render prop" rule for every tag. | Rejected: `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform "attribute tags become props" rule for every tag. | Rejected: `Tag does not support nested attribute tags.` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>.` |

## Known bugs, not divergences

These are `@mxlang/html` implementation bugs against the rule "the translator should follow Marko", not intentional divergences:

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a failed custom-element lookup and refuses to compile. `@mxlang/html`'s `isElement` instead treats any hyphenated name as literal HTML unconditionally, so it compiles and renders the tag as-is.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag reference outright. `@mxlang/html`'s `isComponent` is binding-based regardless of case, so it calls the import successfully instead of erroring — strictly *more permissive* than Marko.
