---
title: "The IR"
description: "The intermediate representation between the core and hosts."
---

# The IR

The core resolves structural markup into an intermediate representation (IR) first, and a host acts as a thin emitter that prints that IR into its target framework's own public input language.

"Prints into its target framework's own public input language" is the important constraint. A host does not emit compiled or optimized output — it emits ordinary JSX source text, or an ordinary string-concatenation function body, exactly the shape a human author would have written by hand. The host's normal toolchain (Babel, a bundler, the target framework's own compiler) then runs on that text unmodified, the same way it runs on anyone else's code. This is what keeps a host from becoming a second compiler for its target framework: it is a printer, not a compiler.

A host's job is to: resolve structure once in the core, then write an emitter for one IR to one target syntax.

## HostDeclarations

The `HostDeclarations` type specifies how a host declares its supported inert tags and stateful constructs. This ensures the IR knows exactly which components should be parsed vs treated as literals, and which tags trigger compiler errors in strict mode.
