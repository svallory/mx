/**
 * `<try>` attempted as a custom tag (decision 85, experiment
 * `custom-tags-check`, item 3).
 *
 * The expected-to-fail half of the experiment, kept because *where* it breaks
 * is the finding. Three attempts, each a different guess at how a pure-IR
 * expansion could express an error boundary, each run by `probe.ts` and each
 * recorded there with its exact failure.
 *
 * The one-line answer: `<try>` lowers to a *target construct* — `try`/`catch`
 * statements in the string host, `<Errored>` in Solid, `MxErrorBoundary` in
 * Preact/React, `ErrorBoundary` in Hono — and the IR has no node for "call a
 * host runtime helper" or "wrap these children in a statement". Every IR kind
 * is either markup (`Element`, `Text`, `Interpolation`), structural control
 * flow the core itself defines (`IfChain`, `For`, `Define`, `Const`), a
 * hoisted statement (`Hoisted`, `Static`), or `HostTag` — and only the last
 * reaches a target primitive, which is exactly the boundary this file
 * measures.
 */

import type {
  CustomTagCall,
  CustomTagContext,
  CustomTagDefinition,
  IrNode,
} from "@mxlang/core";

/**
 * Attempt 1 — emit the boundary as markup.
 *
 * The shape a naive author reaches for: wrap the body in *something*, the way
 * `<icon>` wraps paths in an `<svg>`. It compiles and renders, and it is
 * wrong on every host: `Element{name:"mx-try"}` is a literal unknown element
 * in the output, and the `<@catch>` body is simply dropped. This is the S8
 * silent-drop class, reached by a *user's* tag rather than by MX's own code —
 * which is itself a finding about what the contract must forbid.
 */
export const asMarkup: CustomTagDefinition = {
  expand(call: CustomTagCall, ctx: CustomTagContext): IrNode[] {
    return [ctx.build.element("mx-try", [], call.content?.children ?? [])];
  },
};

/**
 * Attempt 2 — emit the boundary as a component call.
 *
 * Closer, and the one that nearly works: `Component{target:{kind:"name"}}` is
 * how every host calls a component, so a tag *could* name a boundary
 * component the host ships. Two things break it, and both are structural
 * rather than incidental:
 *
 * 1. **There is no import.** `Component.target.kind === "name"` names a
 *    binding the *template* must already have; the core resolves the name
 *    against `ctx.imports`. A custom tag cannot add a module-scope import
 *    (§5.3: it would need cross-call dedup, ordering and a collision rule),
 *    so the emitted call references a name nothing bound — a `ReferenceError`
 *    at render time, or a `tsc` error in the emitted module.
 * 2. **The component is host-specific.** `MxErrorBoundary` exists only in
 *    Preact and React's runtimes, `ErrorBoundary` only in `hono/jsx`,
 *    `<Errored>` only in Solid, and the string host has no component at all —
 *    it emits statements. Naming one is naming a host, which is §6's
 *    host-awareness the design rejects.
 *
 * `probe.ts` runs this one through all six hosts to show exactly that split.
 */
export function asComponent(name: string): CustomTagDefinition {
  return {
    expand(call: CustomTagCall, ctx: CustomTagContext): IrNode[] {
      const katch = call.attributeTags.find((tag) => tag.name === "catch");
      return [
        {
          kind: "Component",
          target: { kind: "name", name },
          nameSpan: null,
          attrs: [],
          content: call.content ? ctx.build.block(call.content.children) : null,
          attributeTags: katch ? [katch] : [],
          args: [],
          loc: call.loc,
        },
      ];
    },
  };
}

/**
 * Attempt 3 — emit the boundary as a hoisted statement.
 *
 * The last IR kind that reaches emitted code: `Hoisted` puts verbatim source
 * at the head of the enclosing function, which is decision 70's hoist hook and
 * the only "arbitrary target code" channel the IR has.
 *
 * It cannot express `<try>` for a reason that is about *position*, not about
 * expressiveness: a hoist lands at the function's head, and the boundary has
 * to wrap the children *where they are*. There is no IR node meaning "open a
 * statement here, put these children inside it, close it after" — the string
 * host's own `<try>` arm does exactly that (`push("try {")`, drive the
 * children, `push("}")`), and it can only do so because it is an *emitter*,
 * holding the output buffer. A custom tag holds no buffer by design.
 *
 * The attempt below is therefore written to show the shape, not to work: it
 * emits the `try {` and the `}` as two hoisted statements, which land
 * adjacent at the function head and produce an empty `try {}` with the body
 * still rendered afterwards, unguarded.
 */
export const asHoist: CustomTagDefinition = {
  expand(call: CustomTagCall, ctx: CustomTagContext): IrNode[] {
    ctx.hoist("try {");
    ctx.hoist("} catch {}");
    return call.content?.children ?? [];
  },
};

/**
 * What the design says to do instead (investigation §6, case 2).
 *
 * A tag needing a target primitive emits a `HostTag` the host already claims.
 * The tag says *what* (`try`), the host says *how*. This works today for
 * every host claiming the name and fails with the host's own diagnostic on a
 * host that does not (`@mxlang/astro`, which has no boundary) — which is
 * correct behaviour, not a gap.
 *
 * **It is deliberately not offered by `ctx.build`.** A `HostTag`'s `data`
 * slot holds whatever that host's own `resolveHostTag` decided, and a custom
 * tag has no way to produce it: forging `{kind:"try"}` means knowing the
 * private shape of six hosts' internal data types, which is host-awareness
 * wearing a different hat. Making this work needs a core change — see the
 * report's `<try>` section.
 */
export const asHostTag: CustomTagDefinition = {
  expand(call: CustomTagCall, _ctx: CustomTagContext): IrNode[] {
    return [
      {
        kind: "HostTag",
        tag: {
          name: "try",
          attrs: [],
          children: call.content?.children ?? [],
          attributeTags: call.attributeTags,
          params: call.params,
          var: null,
          // The hole. Every host reads `data` and fails on `undefined`; what
          // belongs here is that host's own resolve-time record, which only
          // its `resolveHostTag` can produce and which the core never asked
          // for, because the core never saw a `<try>` tag.
          data: undefined,
          loc: call.loc,
        },
        loc: call.loc,
      },
    ];
  },
};
