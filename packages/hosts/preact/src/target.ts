/**
 * The knobs that separate Preact from React, isolated from the emitter.
 *
 * The lowering itself — ternary chains, `.map` with `key`, attribute tags as
 * props, an error boundary around `<try>` — is identical for both targets.
 * What differs is a short list of *names*: the JSX runtime the emitted pragma
 * points at, whether a class attribute is spelled `class` or `className`, and
 * the prop that sets raw HTML. Keeping them in one object is what lets a
 * future `@mxlang/react` import this package's emitter and pass a different
 * `Target` rather than fork 600 lines that would then drift.
 *
 * Deliberately *not* in here: anything the emitter would have to branch on
 * structurally. A knob that required an `if (target.kind === "react")` in the
 * emitter is a sign the two targets have genuinely diverged, and belongs in a
 * second emitter rather than in a boolean here.
 */

export interface Target {
  /** Human-readable target name used in host-specific diagnostics. */
  name: string;
  /** Value of the emitted `/** @jsxImportSource … *\/` pragma. */
  jsxImportSource: string;
  /**
   * How this target spells the class attribute in JSX.
   *
   * Preact accepts both `class` and `className`; `class` is its native prop
   * and what its own documentation uses, so that is what MX emits — an MX
   * author writes `class=` and reads `class=` back out of the generated JSX.
   */
  classAttr: string;
  /** How this target spells HTML's `for` attribute in JSX. */
  forAttr: string;
  /** The prop that sets raw HTML from a sole `$!{expr}` child. */
  rawHtmlProp: string;
  /**
   * How raw HTML is wrapped for that prop. Both targets take
   * `{ __html: expr }`; kept here because it is target vocabulary, not a
   * structural decision.
   */
  rawHtmlValue(code: string): string;
  /** Module the emitted `<try>` lowering imports its error boundary from. */
  errorBoundaryModule: string;
  /** Named export in that module: a component taking `fallback` and children. */
  errorBoundaryName: string;
  /** Named export in that module: the `<try>` placeholder/suspense wrapper. */
  suspenseName: string;
  /** Module the JSX `Fragment` is imported from, for an explicit import. */
  fragmentModule: string;
}

/** The Preact target. */
export const preactTarget: Target = {
  name: "Preact",
  jsxImportSource: "preact",
  classAttr: "class",
  forAttr: "for",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/preact/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "preact",
};
