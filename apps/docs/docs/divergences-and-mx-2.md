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

## Fixed: former HTML host bugs

Two cases where the HTML host was more permissive than Marko were implementation bugs against the rule "the translator should follow Marko", not intentional divergences. Both are fixed, and the Marko-parity oracle reports no translator bugs across the stock fixture set:

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a failed custom-element lookup and refuses to compile. The host used to render it as literal HTML unconditionally; it now rejects it with Marko's own wording.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag reference outright. The host was binding-based regardless of case, so it called the import instead of erroring; it now rejects it with Marko's own wording. The forms that do work are `<${layout}/>` and `<Layout/>`.

## Candidates for MX 2

Not divergences today, and not bugs — behaviour MX could deliberately choose to diverge on from MX 2 on, each still needing its own recorded row and the tooling that goes with it before it ships.

- **Unknown custom elements in the vanilla host.** MX 1 follows Marko and refuses to compile an unresolved hyphenated tag. A future MX could instead let it through as a literal custom element, which is what a plain HTML author would expect from `<my-widget>`.
