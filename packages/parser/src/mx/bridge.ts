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
    start: number;
    startLoc: Position;
    end: number;
    endLoc: Position;
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
      ? positionAt(source, first.start, parser.state.startIndex)
      : startLoc;
    throw raiseAndThrow(parser, MxErrors.HtmlParserError, at, {
      message: first?.message ?? "Invalid MX element.",
    });
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
      throw raiseAndThrow(
        parser,
        MxErrors.UnsupportedConstruct,
        positionAt(source, err.failure.start, parser.state.startIndex),
        { construct: err.failure.construct },
      );
    }
    // A Babel SyntaxError from a sub-parse already carries its own position.
    throw err;
  }

  repositionTokenizer(parser, source, start, end, contextDepth);
  return node;
}

/**
 * Raises an MX parse error and returns it to be thrown.
 *
 * `raise` only throws when `errorRecovery` is off; with it on it records the
 * error and returns. The bridge has no valid node to hand back either way — the
 * MX region did not parse — and returning `null` as an expression makes Babel
 * crash later on `expr.type`. So the error is always thrown: `tryParse` catches
 * thrown SyntaxErrors and rolls back, and a top-level parse surfaces it with
 * its position intact, which is what an unparseable region should do under
 * either setting.
 */
function raiseAndThrow(
  parser: MxParserHost,
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  toParseError: any,
  at: Position,
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  details: any,
): unknown {
  return parser.raise(toParseError, at, details);
}

/**
 * Moves the tokenizer to `end` (just past the root tag's close) and reads the
 * next token from there.
 *
 * `pos` alone is not enough:
 *
 * - `curLine`/`lineStart` feed every subsequent `loc`, so they are recomputed
 *   by scanning the region MX consumed.
 * - `start`/`startLoc`/`end`/`endLoc` must be made to describe the MX region as
 *   if it were the token just read. `next()` copies `endLoc` into
 *   `lastTokEndLoc`, and `finishNode` ends every *enclosing* node at
 *   `lastTokEndLoc` — so leaving `endLoc` pointing at the tag-name token (where
 *   the JSX plugin left it) ends the enclosing arrow, return, property or
 *   conditional at `<div` instead of at the closing tag. `hasPrecedingLineBreak`
 *   compares against the same field, so a stale value also makes every
 *   multi-line MX element look like it was followed by a line break, silently
 *   swallowing the missing semicolon in `<div>\n</div> foo`.
 *
 * `type` is still not set by hand — `next()` re-derives it from the
 * repositioned `pos`, which is what keeps the token and the position
 * consistent.
 */
function repositionTokenizer(
  parser: MxParserHost,
  source: string,
  start: number,
  end: number,
  contextDepth: number,
): void {
  const { state } = parser;

  const startLine = state.curLine;
  const startLineStart = state.lineStart;

  let line = startLine;
  let lineStart = startLineStart;
  for (let i = state.pos; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  state.pos = end;
  state.curLine = line;
  state.lineStart = lineStart;

  // Describe the whole MX region as the token that was just consumed, so the
  // next `next()` records an accurate `lastTokEndLoc`.
  state.start = start;
  state.startLoc = positionAt(source, start, state.startIndex);
  state.end = end;
  state.endLoc = new Position(line, end - lineStart, end + state.startIndex);

  state.context.length = contextDepth;
  parser.next();
}

/** A real `Position` for `raise`, which type-tests it with `instanceof`. */
function positionAt(
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
