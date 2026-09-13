/**
 * `@mxlang/preact` — MX's Preact host, the fourth emitter on `@mxlang/core`'s
 * IR (decisions 71, 79, 81, 82).
 *
 * A `.mx` (or `.marko`) template becomes a Preact component module: a JSX file
 * carrying its own `@jsxImportSource` pragma, the author's imports and `static`
 * blocks at module scope, their `export interface Input` as the component's
 * props type, and one default-exported function returning JSX.
 *
 * Everything generic — parsing Marko, resolving to the IR, the
 * `config.translator` seam — is `@mxlang/core`'s. This package supplies the
 * declarations (`emitter.ts`), the lowering, and the one small runtime `<try>`
 * needs (`runtime.ts`).
 *
 * ## Emitted module shape
 *
 * ```tsx
 * \/** @jsxImportSource preact *\/
 * import { Fragment } from "preact";
 * <the author's own imports and static blocks>
 *
 * export interface Input { … }
 *
 * export default function (input: Input) {
 *   <const> and <define> bindings, in source order
 *   return (<jsx/>);
 * }
 * ```
 *
 * The parameter is named `input`, not `props`: that is the name MX templates
 * already read (`${input.title}`), and renaming it at the boundary would make
 * every template's own expressions wrong.
 *
 * ## Hooks
 *
 * A hook call belongs in the *component body*, which is what `<const>` lowers
 * to — `<const/count=useState(0)/>` emits `const count = useState(0);` inside
 * the function, where the rules of hooks are satisfied. A `static` block is
 * module scope and runs once per module, so a hook there would be a rules-of-
 * hooks violation; that is a property of the target, and the README says so
 * rather than this file trying to detect it.
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  compileSource,
  createTranslator,
  drive,
  type Ir,
  type IrNode,
  type RawSourceMap,
} from "@mxlang/core";
import { createEmitter, preactDeclarations } from "./emitter.ts";
import { preactTarget, type Target } from "./target.ts";

export { TranslateError } from "@mxlang/core";
export {
  createEmitter,
  emitPreact,
  PreactEmitter,
  preactDeclarations,
} from "./emitter.ts";
export { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";
export { preactTarget, type Target } from "./target.ts";
export type { CompileResult, RawSourceMap };

const host = {
  /**
   * Marko's own convention: a `.marko`/`.mx` file in a `tags/` directory
   * beside the template is callable as a tag with no import. Kept because this
   * is a host for stock Marko syntax, the same as `@mxlang/html`.
   */
  tagDiscoveryDirs: ["tags"],
};

/** The Marko translator object, for a caller driving `@marko/compiler` itself. */
export const translator = createTranslator(host);

export interface CompilePreactOptions {
  /**
   * The JSX target to emit for. Defaults to Preact; a React package passes its
   * own so it can reuse this emitter rather than fork it.
   */
  target?: Target;
}

/**
 * Which of the emitted module's top-level bindings each import supplies.
 *
 * `Fragment` comes from the JSX runtime's own package, the `<try>` helpers
 * from this package's runtime entry — two different modules, so the emitter's
 * collected set is partitioned here rather than at the point of use.
 */
function importLines(names: Set<string>, target: Target): string[] {
  const lines: string[] = [];
  if (names.has("Fragment")) {
    lines.push(`import { Fragment } from "${target.fragmentModule}";`);
  }
  const runtime = [
    target.errorBoundaryName,
    target.suspenseName,
    "mxClass",
  ].filter((name) => names.has(name));
  if (runtime.length > 0) {
    lines.push(
      `import { ${runtime.join(", ")} } from "${target.errorBoundaryModule}";`,
    );
  }
  return lines;
}

/**
 * Builds the emitted component module for one resolved template.
 *
 * `<const>` and `<define>` are lifted out of the body first: both are
 * *statements* in the emitted function, and JSX has no statement position, so
 * they are emitted above the `return` in the order the author wrote them. A
 * `<const>` deeper in the tree stays an error (see the emitter), because
 * lifting one out of a `<for>` body would change which values it closes over.
 */
export function emitModule(ir: Ir, target: Target = preactTarget): string {
  const emitter = createEmitter(target);

  // Statements first, markup second. Splitting on the top level only: a
  // nested one is refused by the emitter rather than silently relocated.
  const statements: string[] = [];
  const markup: IrNode[] = [];
  for (const node of ir.body) {
    if (node.kind === "Const") {
      statements.push(`const ${node.name} = ${node.init.code};`);
    } else if (node.kind === "Define") {
      const body = createEmitter(target);
      drive(body, node.children);
      const rendered = body.done();
      for (const name of body.runtimeImports) {
        emitter.runtimeImports.add(name);
      }
      statements.push(
        `const ${node.name} = (${node.params.join(", ")}) => (<>${rendered}</>);`,
      );
    } else {
      markup.push(node);
    }
  }

  drive(emitter, markup);
  const body = emitter.done();

  const lines: string[] = [`/** @jsxImportSource ${target.jsxImportSource} */`];
  const imports = importLines(emitter.runtimeImports, target);
  if (imports.length > 0) lines.push(...imports);

  const hoisted = [
    ...ir.imports.map((node) => node.code),
    ...ir.hoisted.map((node) => node.code),
  ];
  if (hoisted.length > 0) lines.push("", ...hoisted);

  lines.push(
    "",
    ir.inputInterface?.code ?? "export interface Input {}",
    "",
    "export default function (input: Input) {",
  );
  // A statement lifted by the core's own hoist hook precedes the author's, so
  // a binding it introduces is in scope for everything that follows.
  for (const node of ir.prelude) lines.push(`  ${node.code}`);
  for (const statement of statements) lines.push(`  ${statement}`);
  lines.push(`  return (<>${body}</>);`, "}", "");

  return lines.join("\n");
}

/**
 * Compiles a `.mx`/`.marko` template to a Preact component module.
 *
 * The returned map is a placeholder identity map, as `@mxlang/html`'s is: the
 * emitter builds text rather than printing a Babel AST, so there are no node
 * positions to derive real mappings from yet. `@mxlang/typescript-plugin`
 * maps from the IR's own node locations instead.
 */
export function compilePreactMx(
  source: string,
  filename: string,
  options: CompilePreactOptions = {},
): CompileResult {
  const target = options.target ?? preactTarget;
  return compileSource(source, filename, preactDeclarations, {
    ...host,
    emitIr: (ir) => emitModule(ir, target),
  });
}

/** `compilePreactMx()` over a file on disk. */
export function compilePreactFile(
  filename: string,
  options: CompilePreactOptions = {},
): CompileResult {
  return compilePreactMx(readFileSync(filename, "utf8"), filename, options);
}
