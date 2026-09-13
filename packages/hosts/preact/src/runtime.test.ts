/**
 * The `<try>` runtime, at the render level.
 *
 * Every other `<try>` test in this package asserts the *emitted JSX text* —
 * that `<@catch>` becomes `<MxErrorBoundary fallback={…}>`. None of them runs
 * the boundary, so a defect inside `componentDidCatch` or
 * `getDerivedStateFromError` would leave the whole lowering looking correct
 * while a thrown error escaped to the caller. These render it for real.
 *
 * ## Where each half is tested, and why
 *
 * An error boundary is a **client-render** mechanism in Preact.
 * `preact-render-to-string`'s synchronous `render` does not run one: its
 * `catch` rethrows anything without a `.then`, handling only thenables for
 * suspense (`preact-render-to-string@6.7.0`, `src/index.js:99-104`). So a
 * thrown error escapes `render()` rather than reaching `componentDidCatch`,
 * and no assertion made here could prove the boundary catches anything.
 *
 * The split that follows from that, rather than from preference:
 *
 * - **Here**: that the boundary is transparent when nothing throws, that
 *   `MxPlaceholder` passes its children through, that `mxClass` joins what
 *   the emitter hands it, and — pinned deliberately — that SSR *does* let a
 *   thrown error escape, so the limitation is recorded rather than assumed.
 * - **`examples/preact-app`'s e2e**: the live catch, in a real browser, which
 *   is the only place a boundary actually runs.
 */

import { type ComponentChildren, createElement, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";

/** A component that throws during render, for the boundary to catch. */
function Boom({ value }: { value?: unknown }): ComponentChildren {
  throw value;
}

function Ok(): ComponentChildren {
  return createElement("p", null, "fine");
}

describe("MxErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    const html = render(
      createElement(
        MxErrorBoundary,
        { fallback: createElement("p", null, "caught") },
        createElement(Ok, null),
      ),
    );

    expect(html).toBe("<p>fine</p>");
  });

  it("does not catch during server rendering, where boundaries do not run", () => {
    // Pinned rather than worked around. `preact-render-to-string`'s sync
    // `render` rethrows anything without a `.then` instead of invoking a
    // boundary, so a `<try>` protects a *client* render only. If a future
    // Preact release ran boundaries during SSR, this test failing is how we
    // would find out — and the `<try>` docs would then need revising.
    expect(() =>
      render(
        createElement(
          MxErrorBoundary,
          { fallback: createElement("p", null, "caught") },
          createElement(Boom, { value: new Error("nope") }),
        ),
      ),
    ).toThrow("nope");
  });

  it("selects a plain fallback node over a function one", () => {
    // The branch `<@catch>` (no params) takes, exercised directly on the
    // component rather than through a render, since the render half cannot
    // run server-side. `<@catch|error|>`'s function form is covered by the
    // browser assertion in `examples/preact-app`'s e2e.
    const boundary = new MxErrorBoundary({
      fallback: createElement("p", null, "caught"),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("nope"),
    );

    expect(render(boundary.render() as VNode)).toBe("<p>caught</p>");
  });

  it("passes the thrown error to a function fallback", () => {
    const boundary = new MxErrorBoundary({
      fallback: (error: unknown) =>
        createElement("p", null, String((error as Error).message)),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("the message"),
    );

    expect(render(boundary.render() as VNode)).toBe("<p>the message</p>");
  });

  it("marks itself caught for a falsy thrown value", () => {
    // The case `runtime.ts`'s own doc comment calls out, and the reason the
    // component tracks `caught` separately from `error`: `throw undefined` is
    // legal JavaScript and a rejected promise can carry one. Keying off the
    // error's truthiness would re-render the failed subtree forever, so this
    // asserts the flag directly — a boolean no render can hide.
    for (const value of [undefined, null, 0, "", false]) {
      const state = MxErrorBoundary.getDerivedStateFromError(value);

      expect(state.caught).toBe(true);
      expect(state.error).toBe(value);

      const boundary = new MxErrorBoundary({
        fallback: (error: unknown) =>
          createElement("p", null, `caught:${String(error)}`),
      });
      boundary.state = state;
      expect(render(boundary.render() as VNode)).toBe(
        `<p>caught:${String(value)}</p>`,
      );
    }
  });
});

describe("MxPlaceholder", () => {
  it("renders its children when nothing suspends", () => {
    const html = render(
      createElement(
        MxPlaceholder,
        { fallback: createElement("p", null, "loading") },
        createElement(Ok, null),
      ),
    );

    expect(html).toBe("<p>fine</p>");
  });
});

describe("mxClass", () => {
  it("keeps a plain string", () => {
    expect(mxClass("a b")).toBe("a b");
  });

  it("takes the truthy keys of an object", () => {
    expect(mxClass({ a: true, b: false, c: 1, d: 0 })).toBe("a c");
  });

  it("flattens an array, recursively", () => {
    expect(mxClass(["x", { y: true, z: false }, ["w"]])).toBe("x y w");
  });

  it("renders nothing for null, undefined, false or an empty string", () => {
    expect(mxClass(null)).toBe("");
    expect(mxClass(undefined)).toBe("");
    expect(mxClass(false)).toBe("");
    expect(mxClass("")).toBe("");
    expect(mxClass([null, undefined, false, ""])).toBe("");
  });

  it("keeps a number, which is a legal class name in HTML", () => {
    expect(mxClass(["col", 12])).toBe("col 12");
  });
});
