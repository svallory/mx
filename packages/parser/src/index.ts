import type { File } from "@babel/types";
import {
  parse as babelParse,
  parseExpression as babelParseExpression,
  type ParserOptions,
} from "./babel/index.ts";

export type { ParseError, ParseResult, ParserOptions } from "./babel/index.ts";
export type { PrintResult, RawSourceMap } from "./mx/print.ts";
export { print, printAst } from "./mx/print.ts";
export type {
  MxAttr,
  MxChild,
  MxElement,
  MxRange,
  MxTagName,
  MxWalkError,
} from "./mx/walk.ts";
export { isVoidTag } from "./mx/walk.ts";

/**
 * The vendored `@babel/parser` entry points, unchanged. Use these to parse
 * plain `.tsx`/`.ts`: they behave exactly like npm `@babel/parser` 7.29.8,
 * including for JSX, because the MX bridge is opt-in (see `parse` below).
 */
export {
  babelParse as parseBabel,
  babelParseExpression as parseBabelExpression,
};

export interface MxParseOptions extends ParserOptions {
  mxRegions?: Array<{ start: number; end: number }>;
}

const MX_DEFAULT_PLUGINS: ParserOptions["plugins"] = ["typescript", "jsx"];

/**
 * Parses a `.solid.mx` file and returns a Babel `File`.
 *
 * The AST contains only standard Babel node types — MX elements come back as
 * ordinary lowered `JSXElement`s, so `@babel/traverse`, `@babel/generator` and
 * existing Babel plugins work on it unmodified. MX-specific facts live in
 * `node.extra.mx`.
 */
export function parse(
  source: string,
  filename: string,
  options: MxParseOptions = {},
): File {
  return babelParse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: MX_DEFAULT_PLUGINS,
    ...options,
    // Turns the forked `jsxParseElementAt` on. Without it the vendored parser
    // is byte-for-byte upstream Babel.
    mx: filename.endsWith(".solid.mx"),
  } as ParserOptions) as unknown as File;
}

/**
 * Parses the file and collects all MX regions by walking the resulting AST.
 * Returned ranges are absolute [start, end) offsets in the source string.
 */
export function collectMxRegions(
  source: string,
  filename: string,
  options: MxParseOptions = {},
): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  try {
    parse(source, filename, { ...options, mxRegions: regions, errorRecovery: true });
  } catch (e) {
    // Ignore parse errors, the array is populated via the bridge.
  }

  // Sort by start position
  regions.sort((a, b) => a.start - b.start);

  // Filter out spurious regions from Babel backtracking:
  // if a region is entirely contained within an earlier region, drop it.
  const outerRegions: Array<{ start: number; end: number }> = [];
  for (const r of regions) {
    const last = outerRegions[outerRegions.length - 1];
    if (last && r.start >= last.start && r.end <= last.end) {
      continue;
    }
    outerRegions.push(r);
  }

  return outerRegions;
}
