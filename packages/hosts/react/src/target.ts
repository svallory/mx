import { createJsxDeclarations, type Target } from "@mxlang/preact";

/** React vocabulary for the shared Preact/React JSX emitter. */
export const reactTarget: Target = {
  name: "React",
  jsxImportSource: "react",
  classAttr: "className",
  forAttr: "htmlFor",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/react/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "react",
};

/** Resolve-time policy shared structurally with Preact, with React diagnostics. */
export const reactDeclarations = createJsxDeclarations("React");
