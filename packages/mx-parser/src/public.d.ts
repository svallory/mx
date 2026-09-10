/**
 * Public types for `@mx/parser` as seen by other packages.
 *
 * Consumers typecheck against this rather than against `src/index.ts`, because
 * the vendored `@babel/parser` source under `src/babel/` needs relaxations
 * (`allowImportingTsExtensions`, looser index/variance checks) that should not
 * leak into every package that merely calls `parse`.
 */
declare module "@mx/parser" {
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
}
