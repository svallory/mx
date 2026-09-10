import { Position } from "../babel/util/location.ts";
import { MxErrors } from "./errors.ts";
import { type LowerContext, LowerError, lowerElement } from "./lower.ts";
import { walkMxRegion } from "./walk.ts";

/**
 * The parser surface `mxParseElementAt` needs. Structural rather than a direct
 * import of the Parser class, so this module stays free of the vendored
 * parser's mixin plumbing.
 */
export interface MxParserHost {
  input: string;
  state: {
    pos: number;
    curLine: number;
    lineStart: number;
    startIndex: number;
    context: unknown[];
  };
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  raise(toParseError: any, at: Position | any, details?: any): unknown;
  next(): void;
  // biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
  options: any;
  // biome-ignore lint/suspicious/noExplicitAny: Babel's own node type is internal
  finishNode?: any;
}

/**
 * Parses one MX element starting at `startLoc` and leaves the tokenizer sitting
 * on the first token after the root tag closes.
 *
 * Called in place of `jsxParseElementAt`, which means it runs *speculatively*:
 * the TypeScript plugin's `parseMaybeAssign` tries the JSX/MX grammar inside a
 * `tryParse` on every `<` in expression position, including ones that turn out
 * to be generic arrows (`<T,>(x: T) => x`). So every failure here has to go
 * through `raise` — `tryParse` decides an attempt failed by comparing
 * `state.errors.length`, and a raw exception from htmljs-parser would escape
 * that contract. Nothing thrown by htmljs-parser is allowed to leave this
 * function.
 */
export function mxParseElementAt(
  parser: MxParserHost,
  startLoc: Position,
): unknown {
  const source = parser.input;
  const start = startLoc.index - parser.state.startIndex;

  // Babel's own context stack must come out exactly as deep as it went in. The
  // JSX plugin pushed `j_oTag` before reaching here (entry depth is always the
  // caller's depth + 1); the MX walk never touches the stack, so truncating
  // back to the entry depth minus that one push is enough.
  const contextDepth = parser.state.context.length - 1;

  const { root, end, errors } = walkMxRegion(source, start);

  if (errors.length > 0 || root === null) {
    const first = errors[0];
    const at = first
      ? offsetPosition(source, first.start, parser.state.startIndex)
      : startLoc;
    parser.raise(MxErrors.HtmlParserError, at, {
      message: first?.message ?? "Invalid MX element.",
    });
    return null;
  }

  const ctx: LowerContext = {
    source,
    options: mxSubParseOptions(parser.options),
  };

  let node: unknown;
  try {
    node = lowerElement(ctx, root);
  } catch (err) {
    if (err instanceof LowerError) {
      parser.raise(
        MxErrors.UnsupportedConstruct,
        offsetPosition(source, err.failure.start, parser.state.startIndex),
        { construct: err.failure.construct },
      );
      return null;
    }
    throw err;
  }

  repositionTokenizer(parser, source, end, contextDepth);
  return node;
}

/**
 * Moves the tokenizer to `end` (just past the root tag's close) and reads the
 * next token from there.
 *
 * `pos` alone is not enough: `curLine`/`lineStart` feed every subsequent
 * `loc`, so they are recomputed by scanning the region MX consumed. `type` is
 * not set by hand — `next()` re-derives it from the repositioned `pos`, which
 * is what keeps the token and the position consistent.
 */
function repositionTokenizer(
  parser: MxParserHost,
  source: string,
  end: number,
  contextDepth: number,
): void {
  const { state } = parser;

  let line = state.curLine;
  let lineStart = state.lineStart;
  for (let i = state.pos; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  state.pos = end;
  state.curLine = line;
  state.lineStart = lineStart;
  state.context.length = contextDepth;
  parser.next();
}

/** A real `Position` for `raise`, which type-tests it with `instanceof`. */
function offsetPosition(
  source: string,
  offset: number,
  startIndex: number,
): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return new Position(line, offset - lineStart, offset + startIndex);
}

/**
 * Options for sub-parsing an expression range. The MX region's own start
 * offsets are absolute already, so `startIndex` is set per range by the caller;
 * everything else follows the outer parse so nested MX keeps working.
 */
// biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
function mxSubParseOptions(options: any): any {
  return {
    plugins: options?.plugins ?? ["typescript", "jsx"],
    sourceType: options?.sourceType ?? "module",
    errorRecovery: false,
  };
}
