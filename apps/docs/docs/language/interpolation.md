---
title: "Interpolation and escaping"
description: "${} vs $!{}, whitespace handling, and HTML comments."
---

# Interpolation and escaping

## `${}` and `$!{}`

`${expr}` interpolates a value and escapes it for safe output:

```html
<p>Hello, ${user.name}</p>
```

If `user.name` is `<script>`, the output contains the escaped entities, not a literal tag.

`$!{expr}` interpolates *without* escaping — use it only when the expression already produces markup you trust:

```html
<div>$!{renderedMarkdown}</div>
```

`$!{...}` is not accepted inside an attribute value at all; Marko's own parser rejects it there before any host runs.

## Whitespace

MX follows Marko's whitespace rule, not JSX's:

- A whitespace-only run of text that contains a newline is dropped entirely. This means ordinary indentation between tags produces no extra text nodes or spaces in the output.
- A whitespace-only run *without* a newline collapses to a single space.
- `${" "}` is the escape hatch when you need a literal space that the newline rule would otherwise drop.
- Comments don't count as content when the whitespace rule decides what to trim.

```html
<p>
  Hello
</p>
```

renders `<p>Hello</p>` — the newlines and indentation around `Hello` are dropped, not preserved as whitespace.

## HTML comments

`<html-comment>` renders as a literal HTML comment, with any `${}` placeholders inside it escaped by a comment-safe rule that differs from ordinary text: only `>` is escaped, while `<`, `&`, and quotes pass through raw. This matches how Marko itself escapes comment content, and it means a placeholder like a commit SHA can appear inside a comment without being mangled:

```html
<html-comment>build ${input.sha}</html-comment>
```
