import type { File } from "@babel/types";
import {
  parse as babelParse,
  parseExpression as babelParseExpression,
  type ParserOptions,
} from "./babel/index.ts";
import { walkMxTemplate } from "./mx/template.ts";

export type { ParseError, ParseResult, ParserOptions } from "./babel/index.ts";
export { normalizeText } from "./mx/lower.ts";
export type { PrintResult, RawSourceMap } from "./mx/print.ts";
export { print, printAst } from "./mx/print.ts";
export type { MxStatement, MxTemplate } from "./mx/template.ts";
export { walkMxTemplate } from "./mx/template.ts";
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
  /**
   * Which MX grammar `source` is written in.
   *
   * - `"expression"` (the default) is the `.solid.mx` case: a TypeScript module
   *   in which `<` in expression position opens an MX element.
   * - `"template"` is the standalone `.mx` case: the whole file is markup, with
   *   `import`/`static`/`export interface Input` as statement tags and any
   *   number of top-level elements.
   *
   * The two share the tokenizer but not the entry point, which is what keeps
   * the default byte-identical to what it was before template mode existed.
   */
  mxMode?: "expression" | "template";
}

const MX_DEFAULT_PLUGINS: ParserOptions["plugins"] = ["typescript", "jsx"];

/**
 * Parses a whole-file `.mx` template.
 *
 * The result is a `File` whose `program.body` is empty and whose
 * `extra.mxTemplate` holds the parsed template. That shape is deliberate: a
 * standalone template is markup with a few statement tags, not a TypeScript
 * program, so there is no honest way to express it in Babel's node types — and
 * inventing one would mean a second AST for downstream tools to understand.
 * The lowering target reads `extra.mxTemplate` and emits its own module text.
 *
 * Walk errors become a `SyntaxError` carrying the position of the first one,
 * matching what a caller already handles from the expression path.
 */
function parseTemplateFile(
  source: string,
  filename: string,
  _options: MxParseOptions,
): File {
  const template = walkMxTemplate(source);

  const first = template.errors[0];
  if (first) {
    const { line, column } = positionOf(source, first.start);
    const error = new SyntaxError(
      `${first.message} (${filename}:${line}:${column + 1})`,
    ) as SyntaxError & {
      loc: { line: number; column: number; index: number };
    };
    error.loc = { line, column, index: first.start };
    throw error;
  }

  const [endLine, endColumn] = [
    source.split("\n").length,
    (source.split("\n").pop() as string).length,
  ];

  return {
    type: "File",
    start: 0,
    end: source.length,
    loc: {
      start: { line: 1, column: 0, index: 0 },
      end: { line: endLine, column: endColumn, index: source.length },
    },
    errors: [],
    program: {
      type: "Program",
      start: 0,
      end: source.length,
      loc: {
        start: { line: 1, column: 0, index: 0 },
        end: { line: endLine, column: endColumn, index: source.length },
      },
      sourceType: "module",
      interpreter: null,
      body: [],
      directives: [],
    },
    comments: [],
    extra: { mxTemplate: template },
  } as unknown as File;
}

/** Line and 0-based column of an absolute offset. */
function positionOf(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

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
  if (options.mxMode === "template") {
    return parseTemplateFile(source, filename, options);
  }
  return babelParse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: MX_DEFAULT_PLUGINS,
    ...options,
    // Turns the forked `jsxParseElementAt` on. Without it the vendored parser
    // is byte-for-byte upstream Babel.
    mx: true,
  } as ParserOptions) as unknown as File;
}
