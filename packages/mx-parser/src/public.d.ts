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
    [option: string]: unknown;
  }

  /** Parses a `.solid.mx` file into a Babel `File` of standard node types. */
  export function parse(
    source: string,
    filename: string,
    options?: MxParseOptions,
  ): File;

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
