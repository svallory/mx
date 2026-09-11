---
title: "Policy and hooks"
description: "The Policy interface a host implements, and the three hooks for stateful tags."
---

# Policy and hooks

A host supplies one `Policy` object to `@mxlang/core`. Every member, purpose-first:

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name disposition: `inert` (accepted, produces no output, in a declared shape) or `error` (this target cannot express the tag). |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real HTML/SVG element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `emitComponent(ctx, node, name)` | Emits the call to a component, using this host's props convention. |
| `emitSpecial?(ctx, node, name)` | The tag handler — see below. Stateful tags live here. |
| `emitModifier?(ctx, attr)` | Handles or rejects an attribute modifier like `class:foo="x"`. |
| `attrValue?(ctx, name, source)` | Rewrites a structured attribute value (`class`, `style`); left undefined, the value interpolates unchanged. |
| `emitBoundAttr?(ctx, attr)` | Lowers a `:=` two-way binding. |
| `orderAttrs?(tagName, attrs)` | Reorders an element's attributes, for a target that must emit them in an order other than the author wrote them. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at render scope — not called for tag params, which open their own nested scope. |
| `keepComments?` | Whether an HTML comment reaches the compiled output. |
| `escapeFrom` | The import specifier the emitted module's `escape` helper comes from. |

## The three stateful-tag hooks

MX itself defines no meaning for `<let>`, `<effect>`, `<lifecycle>`, `<script>`, or `:=` — those are framework territory, and each host that wants them gives them its own semantics through three capabilities the core provides.

**1. The tag handler — `emitSpecial`.** Every tag the core has no lowering of its own for is offered to the policy by name before the core decides whether it's a component or an element; returning `true` claims it. A host implements a stateful tag like `<signal/count=1/>` here.

**2. Hoisting — `ctx.hoist(code)`.** Lifts a statement to the head of the enclosing function — the render function, or the nearest nested function a `<define>` opened. This is how a declaration written inside a conditional still resolves for code that runs after the conditional:

```html
<if=input.on>
  <signal/count=7/>
</if>
<p>${count}</p>
```

A host that implements `<signal>` with `ctx.hoist` would emit `const count = 7;` at the function head, above the `if` — so the reference in `<p>` after the branch still resolves, regardless of whether the branch ran.

**3. The binding registry — `ctx.bindings.register(name, rewrite)`.** Rewrites identifier *references* to a name the host owns. A host whose reactive state is a getter function — reading it means calling it — registers `count` with a rewrite of `ref => \`${ref}()\``, so `${count + 1}` in the template emits `count() + 1` instead of the raw identifier.

This only rewrites reference *positions*, never declarations: `obj.count` and an object literal's `count:` key are left untouched. Shadowing is respected — a parameter or local declaration of the same name inside an expression shadows the host's binding for that scope, so `xs.map(count => count)` is untouched while `xs.map(x => x + count)` is rewritten. The core does not go further than this; if a host's own construct needs more precise shadowing behavior than reference-position rewriting gives it, that is the host's responsibility to get right.
