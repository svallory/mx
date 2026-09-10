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
export function walkMxTemplate(source: string): MxTemplate {
  const errors: MxWalkError[] = [];
  const statements: MxStatement[] = [];
  const children: MxChild[] = [];

  const stack: MxElement[] = [];
  let pending: MxElement | null = null;
  let pendingAttrName: { name: string; range: MxRange } | null = null;
  let closeStart: number | null = null;
  /** Depth at which a statement tag opened, so its close can be ignored. */
  let statementDepth: number | null = null;

  const range = (r: { start: number; end: number }): MxRange => ({
    start: r.start,
    end: r.end,
  });

  const top = (): MxElement | null =>
    stack.length > 0 ? (stack[stack.length - 1] as MxElement) : null;

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

      addChild({ kind: "element", element: el });
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
