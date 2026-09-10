import generate from "@babel/generator";
import type { File } from "@babel/types";
import { parse } from "../index.ts";

/**
 * A source map in the shape `@babel/generator` produces, which is also the
 * shape Vite's `transform` hook accepts. Declared structurally rather than
 * imported from `source-map` so `@mx/parser` keeps no extra dependency.
 */
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
 * `@babel/generator` ships as CJS with an interop default; under
 * `esModuleInterop` the namespace can arrive as either the function itself or
 * a `{ default }` wrapper depending on the loader. Normalize once.
 */
const generator = (
  typeof generate === "function"
    ? generate
    : (generate as { default: typeof generate }).default
) as typeof generate;

/**
 * Parses `source` and prints it back as JSX source text plus a source map.
 *
 * This is MX's product boundary (spec section 3.2): the lowered AST is never
 * handed downstream as an AST, because `@solidjs/compiler` — the default
 * native Solid 2 backend — only accepts source text. Printing real JSX text
 * ahead of Solid's own transform is the one integration surface that reaches
 * both the native and the Babel backend.
 *
 * `retainLines` keeps generated lines aligned with the original so the second
 * source-map hop (MX text -> JSX text -> Solid's output) stays faithful, and
 * `jsescOption.minimal` stops non-ASCII text from being escaped into `\uXXXX`
 * noise that would not match the hand-written twins.
 */
export function print(source: string, filename: string): PrintResult {
  const ast: File = parse(source, filename);

  const result = generator(ast, {
    sourceMaps: true,
    sourceFileName: filename,
    retainLines: true,
    jsescOption: { minimal: true },
  });

  if (!result.map) {
    throw new Error(`@babel/generator returned no source map for ${filename}`);
  }

  return { code: result.code, map: result.map as RawSourceMap };
}
