/**
 * Public types for `@markox/parser` as seen by other packages.
 *
 * Consumers typecheck against this rather than against `src/index.ts`, because
 * the vendored `@babel/parser` source under `src/babel/` needs relaxations
 * (`allowImportingTsExtensions`, looser index/variance checks) that should not
 * leak into every package that merely calls `parse`.
 */
declare module "@markox/parser" {
  import type { Expression, File } from "@babel/types";

  export interface MxParseOptions {
    sourceType?: "script" | "module" | "unambiguous";
    plugins?: unknown[];
    /**
     * Which MX grammar the source is written in. `"expression"` (the default)
     * is the `.solid.mx` case; `"template"` is a whole-file standalone `.mx`
     * template. See `src/index.ts` for the full contract.
     */
    mxMode?: "expression" | "template";
    [option: string]: unknown;
  }

  /**
   * Parses an MX file into a Babel `File` of standard node types.
   *
   * In `mxMode: "template"` the returned `File` carries the parsed template at
   * `file.extra.mxTemplate` and its `program.body` is empty: a standalone
   * template is markup, not statements, so there is nothing for Babel's own
   * node types to represent. `@markox/html` reads that field.
   */
  export function parse(
    source: string,
    filename: string,
    options?: MxParseOptions,
  ): File & { extra?: { mxTemplate?: MxTemplate } };

  export interface MxRange {
    start: number;
    end: number;
  }

  export interface MxTagName extends MxRange {
    quasis: MxRange[];
    expressions: MxRange[];
  }

  export type MxAttr =
    | { kind: "static"; name: string; nameRange: MxRange; value: MxRange }
    | { kind: "dynamic"; name: string; nameRange: MxRange; value: MxRange }
    | { kind: "boolean"; name: string; nameRange: MxRange }
    | {
        kind: "method";
        name: string;
        nameRange: MxRange;
        params: MxRange;
        body: MxRange;
        async: boolean;
        range: MxRange;
      }
    | { kind: "spread"; value: MxRange; range: MxRange }
    | { kind: "bound"; name: string; nameRange: MxRange; value: MxRange };

  export type MxChild =
    | { kind: "text"; range: MxRange }
    | {
        kind: "placeholder";
        range: MxRange;
        value: MxRange;
        escape: boolean;
      }
    | { kind: "element"; element: MxElement }
    | { kind: "comment"; range: MxRange };

  export interface MxElement {
    name: MxTagName;
    staticName: string | null;
    attrs: MxAttr[];
    children: MxChild[];
    selfClosing: boolean;
    shorthandClasses: MxRange[];
    shorthandIds: MxRange[];
    params: MxRange | null;
    tagArgs: MxRange | null;
    tagVar: MxRange | null;
    range: MxRange;
    closeRange: MxRange | null;
  }

  export interface MxWalkError {
    message: string;
    start: number;
    end: number;
  }

  /** A top-level `import`, `static` or `export` statement in a template. */
  export interface MxStatement {
    kind: "import" | "static" | "export";
    range: MxRange;
  }

  /** A whole-file `.mx` template: its statements and its top-level markup. */
  export interface MxTemplate {
    statements: MxStatement[];
    children: MxChild[];
    errors: MxWalkError[];
  }

  /** Walks a whole `.mx` file. `parse` with `mxMode: "template"` wraps this. */
  export function walkMxTemplate(source: string): MxTemplate;

  /** True for an HTML void element, which takes no closing tag. */
  export function isVoidTag(name: string | null): boolean;

  /**
   * MX's Marko-derived whitespace rule, shared by every lowering target so the
   * targets cannot disagree about what an indented template renders: a
   * whitespace run containing a newline is dropped, one without collapses to a
   * single space. Returns null when nothing survives.
   */
  export function normalizeText(
    raw: string,
    atStart: boolean,
    atEnd: boolean,
  ): string | null;

  /** The vendored `@babel/parser` entry points, for plain `.ts`/`.tsx`. */
  export function parseBabel(input: string, options?: MxParseOptions): File;
  export function parseBabelExpression(
    input: string,
    options?: MxParseOptions,
  ): Expression;

  /** A source map as `@babel/generator` emits it, which is what Vite accepts. */
  export interface RawSourceMap {
    version: number;
    file?: string;
    sourceRoot?: string;
    sources: string[];
    sourcesContent?: (string | null)[];
    names: string[];
    mappings: string;
  }

  export interface PrintResult {
    code: string;
    map: RawSourceMap;
  }

  /**
   * Parses `source` and prints it back as JSX source text plus a source map.
   * This is the artifact every consumer receives (spec section 3.2): the
   * native Solid 2 compiler accepts only source text, never an AST.
   */
  export function print(source: string, filename: string): PrintResult;

  /**
   * Prints an already-parsed MX AST, for callers that must run their own pass
   * over it first and cannot re-parse afterwards — the oracle strips
   * TypeScript with `@babel/preset-typescript` before printing, since the
   * native compiler's JSX frontend has no TypeScript to erase. Shares
   * `print`'s generator options.
   */
  export function printAst(ast: File, filename: string): PrintResult;
}
