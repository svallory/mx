---
title: "The IR"
description: "In progress: an intermediate representation between the core and hosts."
---

# The IR

::: callout warning "In progress"
This page describes a design that is landing now and is not yet shipped. Nothing below is a stable API — check `@mxlang/core`'s own exports before relying on any of it.
:::

Today, a host's `Policy` is consulted while the core walks Marko's AST directly, and each host decides what to emit node by node as the walk happens. The intended direction is to separate those two steps: the core resolves markup into an intermediate representation first, and a host becomes a much thinner emitter that prints that IR into its target framework's own public input language.

"Prints into its target framework's own public input language" is the important constraint. A host does not emit compiled or optimized output — it emits ordinary JSX source text, or an ordinary string-concatenation function body, exactly the shape a human author would have written by hand. The host's normal toolchain (Babel, a bundler, the target framework's own compiler) then runs on that text unmodified, the same way it runs on anyone else's code. This is what keeps a host from becoming a second compiler for its target framework: it is a printer, not a compiler.

Once this lands, a new host's job shrinks further: resolve structure once in the core, then write an emitter for one IR to one target syntax.
