---
title: "SolidMX"
description: "Status of the .solid.mx host — MX markup in JSX's position inside a Solid component file."
---

# SolidMX

SolidMX (`.solid.mx`) is the idea of writing MX markup directly inside a Solid component file, in the same position JSX would go, lowered to Solid's own JSX at compile time. A `.solid.mx` file is otherwise an ordinary TypeScript module — imports, functions, hooks — with MX markup wherever an expression is expected.

**This host is currently paused.** It predates the shared core the HTML and Astro hosts are now built on top of, and will resume once that foundation is far enough along to build SolidMX on it rather than as a one-off implementation of its own.

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
| `<for\|i\| from=a to=b>` | `<Repeat count={b - a + 1} from={a}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a until=b>` | `<Repeat count={b - a}>{(i) => body}</Repeat>` |

`from=`/`to=`/`until=`/`step=` follow the same read-once-per-access discipline as any other Solid JSX attribute — keep them pure (a signal, a literal, or a memo).

These lowerings live at the parser level, as a mechanism, independent of the host integration around them. What is paused is the rest of the host: the Vite integration, the TypeScript virtual-file projection for per-file `Input` typing, and the editor wiring that would make `.solid.mx` a file you can actually build a project with today.
