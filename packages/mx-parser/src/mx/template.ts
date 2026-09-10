import { createParser, TagType } from "htmljs-parser";
import type {
  MxAttr,
  MxChild,
  MxElement,
  MxRange,
  MxWalkError,
} from "./walk.ts";
import { isVoidTag } from "./walk.ts";

/**
 * Whole-file `.mx` template parsing (`mxMode: "template"`).
 *
 * This is the second entry point into htmljs-parser, beside `walkMxRegion`.
 * The two differ in what they are pointed at, not in how they read markup:
 *
 * - `walkMxRegion` is handed a `<` found in *expression* position inside a
 *   TypeScript file and must stop the moment that one element closes, handing
 *   the tokenizer back to Babel. That is the `.solid.mx` path.
 * - This walk owns the entire file. There is no enclosing TypeScript program to
 *   return to, so it never stops early, and a `.mx` file may hold any number of
 *   top-level tags — which is exactly what a template is.
 *
 * Keeping them separate is what makes the mode additive: nothing here runs for
 * a `.solid.mx` parse, so the SolidMX output cannot move.
 *
 * Concise (indentation) mode needs no flag. htmljs-parser is in concise mode
 * until it sees a leading `<`, so `div.card` and `<div class="card">` both work
 * in the same file, and a template that opens with `<` simply never enters it.
 */

/**
 * A top-level statement tag: `import`, `static` or `export`.
 *
 * htmljs-parser has no concept of a JS statement — it reads `import Button
 * from "./b.mx"` as a *tag* named `import` whose attributes are the remaining
 * words. That shape is useless to us, but the tag's range is exactly the source
 * span of the statement, so the text is sliced back out and handed to Babel,
 * which does understand it. `kind` records which keyword opened it, because the
 * three hoist differently: `import` and `static` reach module scope, and
 * `export interface Input` is the template's input type.
 */
export interface MxStatement {
  kind: "import" | "static" | "export";
  /** Source range of the whole statement line. */
  range: MxRange;
}

export interface MxTemplate {
  statements: MxStatement[];
  /** Top-level markup, in source order. */
  children: MxChild[];
  errors: MxWalkError[];
}

/** Tag names that open a statement rather than an element. */
const STATEMENT_TAGS = new Set(["import", "static", "export"]);

/**
 * Constructs that exist in MX but require a reactive runtime, and so cannot
 * appear in a standalone template. Each maps to the message the parse error
 * carries — naming the construct, and saying why it cannot work here, rather
 * than failing as generic syntax.
 *
 * These are rejected in the walk rather than during lowering because a
 * standalone template has no fallback lowering to attempt: the construct is
 * meaningless in a file that renders once to a string, so the earliest
 * possible report is the most useful one.
 */
export const RUNTIME_ONLY_TAGS: Record<string, string> = {
  let: "`<let>` declares reactive state and requires a runtime; standalone MX renders once to a string, so use `<const>` for a render-scope value",
  effect:
    "`<effect>` runs after render and requires a runtime; standalone MX renders once to a string and has no effect phase",
  await:
    "`<await>` suspends rendering and requires a runtime; standalone MX renders once to a string, so resolve the value before rendering",
  script:
    "`<script>` here is a client-side runtime tag; standalone MX has no runtime, so emit a literal `<script>` element from a component or use `$!{}`",
};

/** The `:=` two-way binding, rejected with the same reasoning as the tags above. */
export const BOUND_ATTR_MESSAGE =
  "`:=` is a two-way binding and requires a reactive runtime; standalone MX renders once to a string";

/**
 * Walks an entire `.mx` file and returns its statements and top-level markup.
 *
 * Unlike `walkMxRegion` this reports every error it finds rather than stopping
 * at the first, so a template with two unrelated mistakes shows both.
 */
/**
 * htmljs-parser stays in concise (indentation) mode until it sees a leading
 * `<`. A template whose first *rendered* content is a `${}`/`$!{}`
 * placeholder — nothing at all before it, or only statement tags
 * (`import`/`static`/`export interface Input`), which consume their own
 * lines as text and never touch angle-bracket mode either — never triggers
 * that switch. The tokenizer then reads the placeholder's own `$` as the
 * start of a concise tag name instead of firing `onPlaceholder` (verified
 * directly: `${x}` alone yields a bogus dynamic-name element, `$!{x}` alone
 * yields literal tag-garbage). Markup before the placeholder is unaffected —
 * an explicit `<tag>` anywhere already switches the tokenizer into
 * angle-bracket mode for the rest of the file.
 *
 * A single regex over the raw source cannot reliably tell "nothing but
 * statements precede the placeholder" from "real markup precedes it" — the
 * statement grammar is a full mini-parse in its own right. Detecting the
 * corruption after the fact and reparsing is simpler and cannot regress a
 * template that was already fine: the first pass runs unmodified, and a
 * second, wrapped pass only happens when that first pass's result carries
 * this bug's unmistakable signature.
 */
/**
 * The corrupted child's index in `result.children`, or `null` if none of
 * them show the misparse's signature.
 *
 * The bug is not really about *first-in-the-whole-template* — it is that
 * htmljs-parser drops back to concise (indentation) mode at the start of any
 * line that no explicit `<tag>` has already opened on, and a `${}`/`$!{}`
 * placeholder starting such a line is read as the start of a concise tag
 * name. `<p>hi</p>${x}` (same line) is fine; `<p>hi</p>\n${x}` (placeholder
 * on its own new line) reproduces the bug just as `${x}` alone does. So this
 * checks every child, not only the first.
 */
function findCorruptedPlaceholder(result: MxTemplate): number | null {
  for (let i = 0; i < result.children.length; i++) {
    const child = result.children[i];
    if (child?.kind !== "element") continue;
    const el = child.element;
    // The escaped symptom: a dynamic tag name (`staticName: null`) — standalone
    // MX has no legitimate dynamic tag name (always a parse error in
    // `emit.ts`), so this shape only ever occurs from the misparse. The raw
    // symptom: a static name that is itself the mangled placeholder delimiter.
    if (el.staticName === null || el.staticName.startsWith("$")) return i;
  }
  return null;
}

const WRAP_PREFIX = "<fragment>";
const WRAP_SUFFIX = "</fragment>";

function childRange(child: MxChild): MxRange {
  return child.kind === "element" ? child.element.range : child.range;
}

export function walkMxTemplate(rawSource: string): MxTemplate {
  const unwrapped = runMxTemplateWalk(rawSource, null);
  const corruptedAt = findCorruptedPlaceholder(unwrapped);
  if (corruptedAt === null) return unwrapped;
  // Wrapping the *whole* source would also swap any statement tags
  // (`import`/`static`/`export interface Input`) into angle-bracket mode,
  // where their bare concise-style syntax no longer parses as a tag at all
  // (they would come out as literal text instead of being recognized). Only
  // the markup from whatever precedes the corrupted placeholder needs the
  // wrap: the last statement, or the sibling immediately before it in
  // `children`, whichever ends later. Neither exists for a bare `${x}` alone,
  // which is `0` — wrapping from the very start.
  const lastStatementEnd = unwrapped.statements.reduce(
    (max, s) => Math.max(max, s.range.end),
    0,
  );
  const previousSibling = unwrapped.children[corruptedAt - 1];
  const previousSiblingEnd = previousSibling
    ? childRange(previousSibling).end
    : 0;
  const precedingEnd = Math.max(lastStatementEnd, previousSiblingEnd);
  // Both a statement's range and a sibling element's range stop at the end
  // of their own content, not past the newline after it. Inserting
  // `<fragment>` right there — on the same line, with no separator — reads
  // to htmljs-parser as more of that same line rather than a new tag (a
  // statement fails outright parsing `<` as more attribute text; a sibling
  // element merely re-triggers concise mode, since nothing forces angle mode
  // for what comes right after it on the same line — see
  // `findCorruptedPlaceholder`). Advancing past that one newline (when there
  // is anything to advance past at all) keeps the wrapper on its own line,
  // exactly like a template with real markup already looks.
  const wrapFrom =
    precedingEnd === 0
      ? 0
      : rawSource.indexOf("\n", precedingEnd) + 1 || rawSource.length;
  return runMxTemplateWalk(rawSource, wrapFrom);
}

/**
 * @param wrapFrom Offset from which the template's markup needs a synthetic
 * `<fragment>` wrapper to force angle-bracket parsing (see
 * `isCorruptedLeadingPlaceholder`); `null` disables wrapping.
 */
function runMxTemplateWalk(
  rawSource: string,
  wrapFrom: number | null,
): MxTemplate {
  const errors: MxWalkError[] = [];
  const statements: MxStatement[] = [];
  const children: MxChild[] = [];

  // Wrapping the source in a synthetic `<fragment>` forces angle-bracket mode
  // from the first character after any statements, which is exactly the
  // workaround fixture authors were already doing by hand. Offsets are
  // corrected below so callers see the original source's ranges.
  const needsWrap = wrapFrom !== null;
  const source = needsWrap
    ? rawSource.slice(0, wrapFrom) +
      WRAP_PREFIX +
      rawSource.slice(wrapFrom) +
      WRAP_SUFFIX
    : rawSource;
  /** How much every offset past `wrapFrom` in `source` must shift back. */
  const shiftPoint = wrapFrom ?? 0;
  const offset = needsWrap ? WRAP_PREFIX.length : 0;

  const stack: MxElement[] = [];
  let pending: MxElement | null = null;
  let pendingAttrName: { name: string; range: MxRange } | null = null;
  let closeStart: number | null = null;
  /** Depth at which a statement tag opened, so its close can be ignored. */
  let statementDepth: number | null = null;
  /**
   * `stack.length` at the moment the synthetic wrapper itself is pushed, so
   * "top level" can still mean the author's top level once it is. `null`
   * until then: real markup (e.g. a `<define>` block) can legitimately open
   * and close, at any stack depth, before the wrapper is ever seen, so a
   * static depth computed up front cannot tell those two states apart.
   */
  let wrapperDepth: number | null = null;

  // A position before `wrapFrom` is in the untouched statement prefix and
  // needs no correction; a position at or after it landed after the inserted
  // `WRAP_PREFIX` and must shift back by its length.
  const unshift = (n: number) => (n >= shiftPoint + offset ? n - offset : n);
  const range = (r: { start: number; end: number }): MxRange => ({
    start: unshift(r.start),
    end: unshift(r.end),
  });

  const top = (): MxElement | null => {
    // Before the wrapper is seen, every open element is real markup and
    // "top level" is simply "nothing on the stack". Once it is seen, being
    // *at* the wrapper's own depth (`stack.length === wrapperDepth + 1`,
    // i.e. inside the wrapper but not deeper) is *also* top level — the
    // wrapper is transparent — so only strictly deeper than that counts as
    // having a real parent.
    const floor = wrapperDepth === null ? 0 : wrapperDepth + 1;
    return stack.length > floor ? (stack[stack.length - 1] as MxElement) : null;
  };

  const addChild = (child: MxChild) => {
    const parent = top();
    if (parent) parent.children.push(child);
    else children.push(child);
  };

  const flushAttrName = () => {
    if (pendingAttrName && pending) {
      pending.attrs.push({
        kind: "boolean",
        name: pendingAttrName.name,
        nameRange: pendingAttrName.range,
      });
    }
    pendingAttrName = null;
  };

  const error = (message: string, at: MxRange) => {
    errors.push({ message, start: at.start, end: at.end });
  };

  const parser = createParser({
    onOpenTagStart(r) {
      flushAttrName();
      pending = {
        name: { start: 0, end: 0, quasis: [], expressions: [] },
        staticName: null,
        attrs: [],
        children: [],
        selfClosing: false,
        shorthandClasses: [],
        shorthandIds: [],
        params: null,
        tagArgs: null,
        tagVar: null,
        range: range(r),
        closeRange: null,
      };
    },

    onOpenTagName(r) {
      // In concise mode htmljs-parser reports no `onOpenTagStart` — a line
      // like `import Button from "./b.mx"` or `div.card` opens with the name
      // itself, so this is the first event for the tag and there is nothing
      // `pending` yet. Starting it here makes the two modes converge before
      // any other handler runs; the HTML path has already set it and keeps
      // the `<` in its range.
      if (!pending) {
        pending = {
          name: { start: 0, end: 0, quasis: [], expressions: [] },
          staticName: null,
          attrs: [],
          children: [],
          selfClosing: false,
          shorthandClasses: [],
          shorthandIds: [],
          params: null,
          tagArgs: null,
          tagVar: null,
          range: range(r),
          closeRange: null,
        };
      }
      pending.name = {
        ...range(r),
        quasis: r.quasis.map(range),
        expressions: r.expressions.map((e) => range(e.value)),
      };
      pending.staticName =
        r.expressions.length === 0 ? source.slice(r.start, r.end) : null;

      const name = pending.staticName;

      // A statement tag consumes its whole line as source text, so it must not
      // be treated as markup: telling htmljs-parser it is void stops it from
      // hunting for a closing tag it will never find.
      // Statement tags can only ever occur before the synthetic wrapper (see
      // `wrapFrom` above), never inside it, so this always compares against
      // true top level rather than `topDepth`.
      if (name !== null && STATEMENT_TAGS.has(name) && stack.length === 0) {
        return TagType.void;
      }

      if (isVoidTag(name)) return TagType.void;
      return undefined;
    },

    onTagShorthandClass(r) {
      if (pending) pending.shorthandClasses.push(range(r));
    },

    onTagShorthandId(r) {
      if (pending) pending.shorthandIds.push(range(r));
    },

    onTagParams(r) {
      if (pending) pending.params = range(r.value);
    },

    onTagArgs(r) {
      if (pending) pending.tagArgs = range(r.value);
    },

    onTagVar(r) {
      if (pending) pending.tagVar = range(r.value);
    },

    onAttrName(r) {
      if (!pending) return;
      flushAttrName();
      pendingAttrName = {
        name: source.slice(r.start, r.end),
        range: range(r),
      };
    },

    onAttrValue(r) {
      if (!pending) return;
      const name = pendingAttrName?.name ?? "";
      const nameRange = pendingAttrName?.range ?? range(r.value);
      pendingAttrName = null;
      const raw = source.slice(r.value.start, r.value.end);
      const quoted = raw.charCodeAt(0) === 34 || raw.charCodeAt(0) === 39;
      const attr: MxAttr = {
        kind: r.bound ? "bound" : quoted ? "static" : "dynamic",
        name,
        nameRange,
        value: range(r.value),
      };
      if (attr.kind === "bound") error(BOUND_ATTR_MESSAGE, nameRange);
      pending.attrs.push(attr);
    },

    onAttrMethod(r) {
      if (!pending) return;
      const name = pendingAttrName?.name ?? "";
      const nameRange = pendingAttrName?.range ?? range(r);
      pendingAttrName = null;
      pending.attrs.push({
        kind: "method",
        name,
        nameRange,
        params: range(r.params.value),
        body: range(r.body.value),
        async: r.async,
        range: range(r),
      });
    },

    onAttrSpread(r) {
      if (!pending) return;
      flushAttrName();
      pending.attrs.push({
        kind: "spread",
        value: range(r.value),
        range: range(r),
      });
    },

    onOpenTagEnd(r) {
      if (!pending) return;
      flushAttrName();
      const el = pending;
      pending = null;
      el.range = { start: el.range.start, end: r.end };

      const name = el.staticName;

      // See the matching comment in `onOpenTagName`: a statement is always
      // at true top level, never inside the synthetic wrapper.
      if (name !== null && STATEMENT_TAGS.has(name) && stack.length === 0) {
        statements.push({
          kind: name as MxStatement["kind"],
          range: el.range,
        });
        statementDepth = stack.length;
        return;
      }

      // Runtime-only tags are reported here, once the tag name and its full
      // range are both known, so the error points at the construct itself.
      if (name !== null && RUNTIME_ONLY_TAGS[name]) {
        error(RUNTIME_ONLY_TAGS[name] as string, el.name);
      }

      const closesItself = r.selfClosed || isVoidTag(name);
      el.selfClosing = closesItself;

      // The synthetic wrapper (see `needsWrap` above) exists only to force
      // angle-bracket mode; it is not part of the author's template and must
      // not appear as a child of it. It is identified by exact position —
      // its open tag starts precisely at `shiftPoint`, the untouched prefix's
      // length — rather than "the first tag", because real markup (e.g. a
      // `<define>` block) can legitimately open before the wrap point at
      // `stack.length === 0` too, and must not be mistaken for the wrapper.
      // `el.range.start` has already been unshifted, and `shiftPoint` itself
      // never shifts (it is by definition the boundary the shift starts
      // past), so the two are directly comparable.
      const isSyntheticWrapper = needsWrap && el.range.start === shiftPoint;
      if (isSyntheticWrapper) wrapperDepth = stack.length;
      else addChild({ kind: "element", element: el });
      if (!closesItself) stack.push(el);
    },

    onText(r) {
      if (statementDepth !== null && stack.length === statementDepth) {
        // Trailing newline after a statement line; not template content.
        if (source.slice(r.start, r.end).trim() === "") return;
        statementDepth = null;
      }
      addChild({ kind: "text", range: range(r) });
    },

    onPlaceholder(r) {
      addChild({
        kind: "placeholder",
        range: range(r),
        value: range(r.value),
        escape: r.escape,
      });
    },

    onComment(r) {
      addChild({ kind: "comment", range: range(r) });
    },

    // `<!doctype html>` fires its own event and is otherwise dropped entirely
    // — no text, no element — so a full HTML page would silently lose its
    // doctype. Recording it as a child keeps it in document order, which is
    // the only position it is valid in.
    onDoctype(r) {
      addChild({ kind: "doctype", range: range(r) });
    },

    onCloseTagStart(r) {
      closeStart = r.start;
    },

    onCloseTagEnd(r) {
      const el = stack.pop();
      if (el) {
        el.range = { start: el.range.start, end: r.end };
        el.closeRange = {
          start: closeStart ?? r.start,
          end: r.end,
        };
      }
      closeStart = null;
    },

    onError(r) {
      errors.push({ message: r.message, start: r.start, end: r.end });
    },
  });

  try {
    parser.parse(source);
  } catch (err) {
    errors.push({
      message: err instanceof Error ? err.message : String(err),
      start: 0,
      end: source.length,
    });
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1] as MxElement;
    errors.push({
      message: `Unterminated <${unclosed.staticName ?? "?"}> element.`,
      start: unclosed.range.start,
      end: unclosed.range.end,
    });
  }

  return { statements, children, errors };
}
