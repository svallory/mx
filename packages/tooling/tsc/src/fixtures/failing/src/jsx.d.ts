// Minimal JSX namespace so a fixture exercises MX lowering rather than Solid's
// own types. `children` is deliberately typed: an index signature alone widens
// every expression inside a region to `unknown`, which hides the very argument
// errors these fixtures exist to prove are caught.
declare namespace JSX {
  interface IntrinsicElements {
    p: { children?: string | number };
  }
  type Element = unknown;
}
