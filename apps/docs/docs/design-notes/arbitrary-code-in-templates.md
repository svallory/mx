---
title: "Arbitrary code in templates"
description: "Why Pug allowed bare statements, why Marko removed them, and where MX lands."
---

# Arbitrary code in templates

Should a template accept a bare statement in its body — `$ const x = compute(input)`, `- var x = 1` — or only expressions and declarative constructs like `<const>` and `static`? Two real template languages answered this differently, for reasons that turn out to matter a great deal once a compiler needs to know more about a template than "what HTML does this produce."

## Pug: a template is a function, so a statement just runs

Pug compiles a template into one imperative JavaScript function that appends to a buffer as it goes:

```javascript
buf.push("<div>"); /* … */ buf.push("</div>");
```

Unbuffered code — `- var x = 1` — is spliced verbatim between those buffer pushes. Nothing had to be designed to allow this: the template already *is* a linear function, so a statement on a given line runs exactly when that line's markup would otherwise be emitted. Pug's model was "JavaScript with HTML sugar," predating the component era; unbuffered code plus loop and mixin constructs gave it completeness without inventing more tag-level syntax.

The costs were real, if quietly accepted:

- A template stops being a pure function of its inputs — a statement can do anything, at any point in the render.
- Tooling cannot know what is in scope, because a variable can appear from any line.
- A `var` declared inside a block leaks to later siblings through ordinary JavaScript scoping rules.
- Combined with template inheritance (`extends`/`block`), execution order becomes genuinely hard to predict by reading the file.

None of this stopped Pug from working — it still ships unbuffered code today, unchanged, because removing it would break the overwhelming majority of templates already written against it.

## Marko: scriptlets, then their removal

Marko's early versions expressed inline code with declarative tags (`<var>`, `<assign>`, `<invoke>`), then moved to `$ <statement>` scriptlets with a `static` form for module-level code. These were sound for the same underlying reason Pug's unbuffered code was: the compiler produced two sequential programs — one writing an HTML stream on the server, one building a client-side tree in the browser — each executed top to bottom in a single pass. A scriptlet at a given position had exactly one meaning: run here, during this render. It was the escape hatch for anything the tag vocabulary didn't cover.

That stopped being true once the compiler stopped producing a single sequential pass. A fine-grained reactive compiler splits a template into sections that re-run independently when their inputs change; some sections run only on the server, some resume on the client; the compiler has to know, ahead of time, what gets serialized across that server/client boundary. A bare statement answers none of the questions this kind of compiler needs to ask:

- When does it re-run?
- What does it depend on?
- Is it a side effect, or does it produce a value?
- Does it belong to the server, the client, or both?
- Is its result serialized across the hydration boundary?

So the replacement constructs each *name* their own execution semantics instead of leaving them implicit: a derived value is `<const>`, re-evaluated when its inputs change; state is `<let>`; a side effect with a lifecycle is `<effect>`, `<script>`, or `<lifecycle>`; module-scope, run-once code stays `static`. The general-purpose scriptlet was removed because the compiler could no longer assign it any single semantics — not because scriptlets were considered poor style.

One gap this leaves open deliberately: a side effect that should run *during server rendering* — logging, mutating an accumulator — has nowhere to attach once scriptlets are gone. The only places code runs at all are `static` and ordinary expressions.

## Where MX lands

MX inherits the reactive-compiler discipline, and extends it to a mode Marko's own history didn't need to consider: a mode with *no* reactive runtime at all.

For a host with no reactive target — one that compiles a template to a plain `(input) => string` function, rendered exactly once — Pug's model would be trivially sound to reintroduce: the function is one sequential pass, so a bare statement would have exactly one unambiguous meaning again, the same way it did in Pug and pre-reactive Marko. `<const>` already covers the "compute a derived value" case cleanly. What it doesn't cover is "run this here for its side effect," which is precisely the gap scriptlets used to fill.

The deciding argument against reopening that gap is a possible future reactive mode for the same structural syntax. If a template using a bare statement is allowed to exist under the no-runtime host, that template can never be moved to a reactive host later, for exactly Marko's own reasons: a statement with unnamed semantics is meaningless once the compiler needs to know when it reruns and what it depends on. Allowing it in one mode and not the other would fork MX into two incompatible dialects rather than one structural core shared by every host.

So scriptlets stay out of every MX host, including the ones with no reactive runtime to protect. The tradeoff is explicit: a host with no runtime gives up a small piece of Pug-style convenience (the "just run this here" escape hatch) in exchange for every template staying portable across every host that might compile it, reactive or not. If a genuine need for a server-render-only side effect ever appears, it will be a deliberate addition to MX's vocabulary — its own named construct, not a scriptlet revival — because Marko itself never solved that case either.
