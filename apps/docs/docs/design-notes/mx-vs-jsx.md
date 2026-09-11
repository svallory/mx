---
title: "MX vs JSX for framework authors"
description: "What integrating JSX costs a framework author today, what a compile-time IR offers instead, and where MX would actually fit."
---

# MX vs JSX, for framework and library authors

Would a framework author pick MX over JSX, or recommend it to their users? The honest answer depends on what JSX already costs framework authors today, and what a compile-time intermediate representation can offer that JSX structurally cannot.

## What integrating JSX costs a framework author today

JSX looks like one shared syntax, but it is not one shared *compiler*. Every framework that wants compile-time facts about a template has had to build its own.

**Solid** cannot reuse React's JSX transform. It ships its own compiler with distinct output modes for client DOM, hydratable server output, and custom renderers, because Solid's own documentation is explicit that JSX is borrowed syntax layered over a non-virtual-DOM execution model — meaning Solid's compiler has to re-derive, from opaque JSX expressions, exactly which parts of a template are static and which are dynamic.

**Vue** supports JSX only through a separate, additive package alongside its primary template compiler, and says so directly: JSX's optimizations are "not as comprehensive as those in Vue's official template compiler," specifically because JSX's dynamic nature limits what the compiler can prove about it. Vue keeps its template syntax as the recommended path for exactly this reason.

**Svelte** deliberately did not adopt JSX at all. Its compiler needs to know, statically, everything that can happen inside a template — and "inside the curly brackets in JSX, you could have literally any JavaScript expression whatsoever," which makes it extraordinarily difficult for a compiler to bound the possibilities. Svelte's HTML-first syntax exists specifically to be compilable in a way JSX is not.

**Qwik** ships its own JSX transform plus a separate compiler stage — the Optimizer — that walks `$`-marked boundaries and extracts each into its own lazy-loadable module, because ordinary JSX carries no concept of a lazy-load boundary at all.

**Preact** cannot simply consume React's JSX output either: it ships a permanent compatibility layer built into its core runtime to absorb React-specific assumptions baked into JSX-emitted code, such as emulating React's synthetic-event behavior for `onChange` on `<input>`.

**Lit** skips JSX entirely in favor of tagged template literals, precisely because a template literal's static strings survive as an unchanging cache key the runtime can diff against — a property no arbitrary function call carries.

**Astro** does not use JSX in its own component files; it compiles a JSX-*like* syntax with its own independent compiler.

**Marko** — the language MX descends from — has never used JSX. It has its own HTML-like grammar with first-class `<if>`, `<for>`, attribute-tag, and tag-param constructs, the same constructs MX's structural core lifts directly.

A cross-cutting cost sits underneath all of this: TypeScript effectively has one global JSX namespace per compilation, so multiple JSX-based frameworks sharing a codebase can produce real type conflicts in `JSX.IntrinsicElements`. And because JSX itself carries no static/dynamic annotation, every framework that wants that information has to derive it by *inference* over opaque expressions — `.map()` calls, ternaries, `&&` chains — rather than read it directly off the syntax. Each one then separately maintains its own Babel/SWC/esbuild transform, its own Prettier support, its own ESLint plugin, and its own editor layer beyond generic JSX highlighting.

## What a compile-time template language can offer instead

The frameworks that get real compile-time leverage all did it the same way: by building infrastructure that reads facts directly off template *structure*, rather than reverse-engineering them from arbitrary expressions.

Vue's compiler computes `PatchFlags` — a bitflag classifying exactly what kind of change a given element can undergo (text-only, class-only, a full dynamic-props case, and so on) — purely by analyzing template markup, then uses that to hoist static subtrees out of the render function entirely and build a flat list of dynamic nodes instead of re-diffing a whole tree. None of this is available to Vue's own JSX plugin at the same fidelity.

Svelte's compiler builds a dependency graph for reactive statements by tracking which reactive values are read where, and in its newer rune-based reactivity model pushes that precision directly into compiled output with no runtime reactivity overhead — tractable only because the compiler can see the template's full structure, not opaque function calls.

Solid's own JSX compiler performs the analogous static/dynamic split by walking JSX structurally to find a template's constant parts, generating one clone call for those and targeted effect calls for the dynamic remainder — the same category of fact Vue and Svelte compute, just harder to extract because it has to be recovered from JSX rather than read directly off a purpose-built grammar.

This is exactly the shape an intermediate representation buys: if the compiler already resolves if-chains with their branches, loops with their kind and params normalized, attribute tags grouped with their own params, and component invocations with their resolved input shape, every host consuming that IR gets those facts as *structure*, not as something each host has to re-derive by its own heuristics. Declarative control flow that a compiler can see and understand — rather than an opaque `.map()` or ternary — is also Angular's own stated reason for replacing directive-based `*ngIf`/`*ngFor` with compiler-native `@if`/`@for` blocks: they are "not directives — they are part of the Angular compiler itself, which is why they can be more optimised," and the new `@for` requires an explicit tracking expression so the common mistake of a missing one becomes structurally impossible rather than a runtime footgun.

Slots and attribute tags as first-class syntax are a related win: in JSX, slot-like content is just another prop value the framework's runtime has to interpret at run time, with no compile-time slot concept in the syntax itself. A grammar with attribute tags as real syntax gives every host that same information ahead of time.

## Precedent for a syntax shared across independent runtimes

The closest existing precedent is Vue's own compiler-core, published separately from Vue itself and reused by both a lightweight subset runtime and Vue's newer no-virtual-DOM compilation target — one template syntax, two materially different runtime output shapes. That is direct evidence the "one syntax, multiple emitters" bet works, though so far only within one framework's own ecosystem, not yet across genuinely unrelated frameworks.

Angular's move to compiler-native control flow is separate but reinforcing evidence: a major, mature framework chose to move *away* from expression-based control flow toward syntax its own compiler can see through, specifically for optimization, type-narrowing, and ergonomics — the same category of argument MX's structural `<if>`/`<for>` tags make.

None of this amounts to a shared template language already adopted by multiple *independent* frameworks — that has not happened yet, anywhere. It is evidence of real, recurring demand for the underlying capability, not evidence that the specific cross-framework version already exists.

## What this would take, honestly

A framework author evaluating MX today would reasonably ask for things that are only partly in place: a stable, versioned IR contract (the shapes exist; a versioning policy for a future extension point does not, yet); a host-agnostic conformance kit with shared fixtures (there is a real oracle for structural parity against Marko, but not yet a fixture-sharing mechanism that spans multiple, materially different hosts); a typed `Input` contract generation story for TypeScript (not yet present); and, most concretely, a second host with genuinely different output semantics from the first ones. The hosts that exist so far both render to strings at some point in their pipeline; a fine-grained reactive DOM host, built directly on the shared core rather than as a one-off, is the evidence that would make the "one language, many hosts" pitch land with a skeptical framework author rather than merely a hopeful one.

## Where this realistically lands

The plausible audience is not a framework with an existing, mature JSX compiler and an entrenched ecosystem behind it — that switching cost has already been paid and absorbed. It is a smaller or newer framework that does not want to build a Solid- or Qwik-style compiler team from scratch: static-and-islands frameworks, edge-runtime frameworks, or any new framework author facing the same choice Solid and Qwik once faced and looking for infrastructure they don't have to build themselves. The pitch that fits the evidence is narrow and deliberately unglamorous: one declarative template syntax with compiler-visible control flow, and more than one host emitting from it, so the next framework author doesn't have to independently re-derive what Solid, Vue, and Svelte each derived on their own.
