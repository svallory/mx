---
title: "Introduction"
description: "What MX is, what it is not, and how the subset rule works."
---

# MX

MX (Markup eXtended) is a template language born from Marko. It takes Marko's syntax — the syntax people already know from Marko — and brings it to wherever JSX lives today: Solid, Astro, and eventually React and server-side HTML. MX itself defines the markup and the structural tags; each **host** decides what state, reactivity, and output mean.

`.mx` is the official file extension. `.marko` is accepted everywhere with identical treatment, so porting a Marko component to MX is a rename or nothing.

## What MX is

- **The language.** A markup grammar plus a small set of structural tags: `<if>` / `<else if>` / `<else>`, every `<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`, `import`. These work identically on every host and render exactly the way Marko renders them.
- **The core.** One package (`@mxlang/core`) that consumes Marko's AST, applies the structural lowerings, and exposes a `Policy` interface plus three hooks so a host can add its own stateful tags.
- **The hosts.** Each host is a policy over the core, plus the integration that makes it usable in that ecosystem:
  - **HTML** — a `.mx` file compiles to a pure `(input) => string` function. No runtime, no framework.
  - **Astro** — `.mx` components and pages render to static markup at build time, no islands, no client JavaScript.
  - **SolidMX** (`.solid.mx`) — MX in JSX's position inside a Solid component file, lowered to Solid's own JSX. Currently paused; see [SolidMX](/hosts/solidmx/).

## What MX is not

- **Not a Marko runtime.** No resume, no serialized scope data, no `@marko/runtime-tags`. A host that wants client-side state uses its own framework's mechanisms. See [why MX has no resume](/design-notes/marko-runtime-modes/).
- **Not a promise of portability for stateful templates.** A template using `<let>` means one thing on the HTML host (an error, unless explicitly allowed) and something else on a future reactive host — the same way JSX means something different depending on which framework compiles it. The structural core is portable; stateful tags are host-bound.
- **Not a superset of Marko.** MX 1.0 is a strict *subset*.

## The subset rule

Every MX 1.0 file is a valid Marko file, with the same meaning for the structural core. A host may *forbid* a tag it cannot honor — the Astro host rejects `<let>` because it has no reactive target — but no host may add syntax, attribute forms, or file conventions that Marko's own parser and language server would reject. This is what lets MX borrow Marko's whole toolchain (its tree-sitter grammar, its Prettier plugin, its language server) by aliasing alone, with nothing forked.

The rule holds until MX 2. From MX 2 on, MX may diverge from Marko, but only deliberately and one recorded step at a time.

## Divergence policy

Every deliberate divergence from Marko syntax is recorded in a table — what changed, why, and what test guards it — before it ships, and it lands only together with the tooling it affects (grammar, formatter, language server). As of this writing there are no deliberate divergences: MX 1.0 is Marko syntax, unmodified. There are two known implementation bugs in the HTML host that are *not* divergences (the host is simply more permissive than Marko in two narrow cases); see the host's own documentation for the two cases.

## Where to go next

- [Language](/language/structural-tags/) — the structural tags, attribute tags, interpolation, and what a host is free to define itself.
- [Architecture](/architecture/core-and-hosts/) — how the core and hosts fit together.
- [Hosts](/hosts/html/) — install and use the HTML host, the Astro host, or read about SolidMX's status.
- [Editors](/editors/zed/) — Zed, VS Code, and the diagnostics language server.
- [Contributing](/contributing/) — repo layout, the verification chain, and how to add a host.
