---
title: "Template tags"
description: "Author L1 custom tags as ordinary MX templates under tags/."
---

# Template tags

An L1 custom tag is an ordinary `.mx` file in a discovered tag directory. `tags/icon.mx` defines `<icon>`; no sidecar or import is required. The template is lowered once, cached, and spliced into the caller's IR at every call site.

Every example below is copied from a passing core fixture or template-expansion test.

## Attributes are `input` reads

Read a call's attributes as `input.<name>` or `input["name"]`:

```marko
<div>${input.title}${input.count}</div>
```

The passing call-site case is:

```marko
<box title="hello" count=2/>
```

MX substitutes the attribute expressions into the template. An omitted attribute becomes `undefined`, so ordinary fallbacks work:

```marko
<div>${input.size ?? 24}</div>
```

Substitution is AST-based and parenthesized where needed, preserving JavaScript scope and operator precedence.

## Body content

Place the caller's body with a dynamic tag over `input.content`:

```marko
<section><${input.content}/></section>
```

For this call:

```marko
<box><em>body</em></box>
```

the `<em>` block is spliced into the `<section>`. If a caller supplies body content and the template has no `<${input.content}/>` placeholder, MX warns that the body was dropped.

## Attribute tags

Place `<@name>` content through `input.<name>.content`:

```marko
<ul><${input.item.content}/></ul>
```

Repeated attribute tags remain repeated and preserve their order:

```marko
<list><@item>one</@item><@item>two</@item></list>
```

An unplaced attribute tag produces a warning naming the missing placeholder. Attribute-tag declarations and repeat/required checks belong in an optional [sidecar](/custom-tags/sidecars/).

## Params

Tag params remain scoped to the caller's body block:

```marko
<box|row|>${row}</box>
```

When the template places `<${input.content}/>`, that block still owns `row`; a template declaration cannot capture it.

## Hygiene

Render-scope declarations introduced by a template are private. MX renames `<const>` and `<define>` bindings to generated names and rewrites only genuine references, respecting nested JavaScript and MX scopes. A caller cannot read a template's private binding, and a caller binding with the same spelling is unaffected.

Module statements behave differently because the expanded markup still needs them: `import`, `static`, and `export` statements hoist to the caller's module. Identical imports are deduplicated. The same local import name referring to different modules is an error naming both files. A template's `export interface Input` does not hoist, because it would collide with the caller's interface.

For example, this import is emitted once even when `<box/>` appears repeatedly:

```marko
import helper from "./helper.ts"
<div>${helper()}</div>
```

## What a template cannot do

A template can arrange markup and use MX's structural language, but it cannot examine compile-time AST shapes, compute a new IR structure in TypeScript, or refuse a call with a custom diagnostic. Add an [L2 sidecar](/custom-tags/sidecars/) for those jobs.

Template calls also reject spread attributes. Their keys are unknown until runtime, while `input.<name>` substitution must resolve every read at compile time.

## The inherent evaluation limit

An attribute expression is substituted at each read. If a template reads `input.size` twice, a call such as this evaluates `next()` twice:

```marko
<box size=next()/>
```

Do not read a side-effecting attribute more than once in an L1 template. Use a sidecar when the value must be computed once and reused.

## Errors to recognize

- **`input` used as a value.** Bare `input`, `input?.size`, `typeof input`, destructuring it, or spreading it cannot be resolved. Read only `input.<name>` or `input["name"]`.
- **Reserved `content`.** A call cannot pass an attribute named `content`; that name is the body slot.
- **Import collision.** Two templates, or a template and its caller, imported the same local binding from different modules. Rename one import.
- **Template cycle.** Calls formed a cycle such as `a.mx -> b.mx -> a.mx`. Break the cycle; expansion is depth-first and recursive cycles are never emitted.

Diagnostics raised while lowering template-authored markup point to the template file and its real line. Errors in call attributes stay on the calling file.
