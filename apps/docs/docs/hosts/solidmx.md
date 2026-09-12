---
title: "SolidMX"
description: "The .solid.mx host — MX markup in JSX's position inside a Solid component file, lowered to Solid 2 JSX."
---

# SolidMX

SolidMX (`.solid.mx`) is MX markup written directly inside a Solid component file, in the same position JSX would go, lowered to Solid's own JSX at compile time. A `.solid.mx` file is otherwise an ordinary TypeScript module — imports, functions, hooks — with MX markup wherever an expression is expected.

SolidMX ships as `@mxlang/solid` (`packages/hosts/solid`), the third emitter over `@mxlang/core`'s shared IR alongside the HTML and Astro hosts. `@mxlang/parser`'s vendored Babel fork finds each MX region inside a `.solid.mx` file and hands it to `@mxlang/solid`'s `compileSolidMx`, which resolves the region through the same Marko-syntax core every host shares and emits Solid JSX text back into the surrounding TypeScript module. `@mxlang/vite-plugin`'s `.solid.mx` transform, the two examples (`examples/counter-app`, `examples/todomvc`) and the SolidMX oracle (`bun run oracle`, `packages/oracle`) all exercise this path end to end.

## The idea

Two rules make MX markup work naturally inside Solid, both applying to any tag, not only Solid's built-in control-flow components:

**Tag params turn children into a function.** `<Tag|p1, p2|>body</Tag>` lowers to `<Tag>{(p1, p2) => body}</Tag>`. This is what lets Solid's own render-prop components be called directly from MX markup:

```html
<For|item, i| each=xs()>
  <li>${i}: ${item}</li>
</For>

<Show|user| when=user()>
  <p>Hello, ${user.name}</p>
</Show>
```

**Attribute tags become props.** `<@name>body</@name>` inside any tag becomes `name={body}` on the parent; `<@name|p|>body</@name>` becomes `name={(p) => body}`.

## `<for>` lowering

Every `<for>` form lowers to one of Solid's own iteration primitives:

| Written | Lowers to |
|---|---|
| `<for\|item, i\| of=xs()>` | `<For each={xs()} keyed={false}>{(item, i) => body}</For>` |
| `<for\|item, i\| of=xs() by="id">` | `<For each={xs()} keyed={x => x.id}>{(item, i) => body}</For>` |
| `<for\|k, v\| in=obj()>` | `<For each={Object.entries(obj())} keyed={e => e[0]}>{([k, v]) => body}</For>` |
| `<for\|i\| from=a to=b>` | `<Repeat count={(b) - (a) + 1} from={a}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a until=b>` | `<Repeat count={(b) - (a)}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a to=b step=s>` | `<Repeat count={N}>{(mxIndex) => { const i = (a) + mxIndex * (s); return body; }}</Repeat>` |

`from=`/`to=`/`until=`/`step=` follow the same read-once-per-access discipline as any other Solid JSX attribute — keep them pure (a signal, a literal, or a memo). With `step=` present, `from`/`to`/`until`/`step` are each re-read once per row rather than once for the whole range — see `packages/hosts/solid/README.md` for the exact discipline this requires.

These lowerings, and everything else `.solid.mx` markup can express (elements, components, `<if>`/`<else>`, `<try>`, the removed Solid 2 attribute namespaces, stateful-tag errors), live in `@mxlang/solid`; `packages/hosts/solid/README.md` is the full lowering table and error list. `<if\|u\|=cond>` (tag params on `<if>`), tag params and `<@name>` attribute tags on native HTML elements, and a `<fragment>` wrapper are not part of MX 1 — real Marko itself rejects each of them (decision 72's subset rule), and `divergences.md`'s "Deferred to MX 2" table records why they were wanted and Marko's exact error.
