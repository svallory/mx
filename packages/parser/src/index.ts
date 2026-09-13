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

export interface MxParseOptions extends ParserOptions {}

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
 * Parses the file and collects every MX region's `[start, end)` absolute
 * source offsets, read off `node.extra.mx.range` (stamped by the bridge on
 * each region root — see `mx/bridge.ts`'s `stampRoot`) rather than threading
 * a dedicated parser option: the AST already carries this fact.
 */
export function collectMxRegions(
  source: string,
  filename: string,
  options: MxParseOptions = {},
): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let file: File;
  try {
    file = parse(source, filename, { ...options, errorRecovery: true });
  } catch {
    return regions;
  }

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const extra = record.extra as
      | { mx?: { range?: [number, number] } }
      | undefined;
    if (extra?.mx?.range) {
      const [start, end] = extra.mx.range;
      regions.push({ start, end });
      return;
    }
    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      visit(record[key]);
    }
  };
  visit(file);

  regions.sort((a, b) => a.start - b.start);
  return regions;
}
