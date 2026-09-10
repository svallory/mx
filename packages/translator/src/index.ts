import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { emitProgram, TranslateError } from "./translate.ts";

export { escape } from "@markox/html";
export { policy, TranslateError } from "./translate.ts";

const require = createRequire(import.meta.url);

export interface RawSourceMap {
  version: number;
  file: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompileResult {
  code: string;
  map: RawSourceMap;
}

/**
 * The Marko translator object, for `compile(src, file, { translator })`.
 *
 * This is the seam decision 66 names: `@marko/compiler` selects a translator
 * by `config.translator`, and a translator supplying only `translate` (plus
 * its taglibs) injects no runtime at all — the emitted module's entire runtime
 * surface is the `escape` import.
 *
 * `tagDiscoveryDirs: ["tags"]` is Marko's own convention, so a `.marko` file
 * in a `tags/` directory beside the template is callable as a tag with no
 * import — one of the things that makes this a translator for *stock* Marko
 * rather than for MX's dialect.
 */
export const translator = {
  taglibs: [["mx-translator-core", require("../taglib/marko.json")]],
  tagDiscoveryDirs: ["tags"],
  translate: {
    Program: {
      exit(path: {
        node: { body: unknown[] };
        hub: { file: { opts: { filename?: string } } };
      }) {
        const state = current;
        if (!state) throw new Error("@markox/translator: no compile in flight");
        state.code = emitProgram(
          path.node.body,
          state.source,
          printExpression,
          state.lookup,
        );
        path.node.body = [];
      },
    },
  },
};

interface CompileState {
  source: string;
  code: string | null;
  lookup?: { getTag(name: string): { taglibId?: string } | undefined };
}

/**
 * The compile in flight.
 *
 * `translate` is a plain visitor the compiler calls; it receives the AST but
 * not the original source text or the taglib lookup, both of which the
 * lowering needs (source for statement-tag slicing, lookup for element and
 * component resolution). A module-scoped handle is how the visitor reaches
 * them. `compileSync` is synchronous and single-threaded, so there is never
 * more than one.
 */
let current: CompileState | null = null;

/**
 * Compiles a stock `.marko` template to a runtime-free TypeScript module.
 *
 * The emitted module imports `escape` and default-exports
 * `(input: Input) => string` — nothing else is required at run time. This is
 * the "expressions-only" output mode of `notes/marko-runtime-modes.md`,
 * implemented as a translator rather than a fork.
 *
 * The returned map is a placeholder identity map: the translator builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from yet.
 */
export function compile(source: string, filename: string): CompileResult {
  // Required lazily and by CJS: `@marko/compiler` is a large dependency and
  // only `compile()` needs it, so importing `escape` stays free.
  const compiler = require("@marko/compiler");

  const state: CompileState = { source, code: null };
  // The lookup is keyed on the translator object, so asking for it here gets
  // exactly the taglibs this translator registers plus Marko's own element
  // taglibs — and the `tags/` directory beside this particular file.
  state.lookup = compiler.taglib.buildLookup(dirname(filename), translator);

  const previous = current;
  current = state;
  try {
    compiler.compileSync(source, filename, {
      translator,
      output: "html",
      writeVersionComment: false,
    });
  } finally {
    current = previous;
  }

  if (state.code === null) {
    throw new Error(`${filename}: translator produced no output`);
  }

  return {
    code: state.code,
    map: {
      version: 3,
      file: filename,
      sources: [filename],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
  };
}

/** `compile()` over a file on disk. */
export function compileFile(filename: string): CompileResult {
  return compile(readFileSync(filename, "utf8"), filename);
}

/**
 * Compiles a set of templates, returning the emitted module for each.
 *
 * The CLI-free equivalent of a build step: a caller writes the results
 * wherever its own pipeline wants them.
 */
export function build(filenames: string[]): Map<string, CompileResult> {
  const results = new Map<string, CompileResult>();
  for (const filename of filenames) {
    results.set(filename, compileFile(filename));
  }
  return results;
}

/**
 * Prints one expression node back to source text.
 *
 * The translator emits TypeScript text rather than a Babel AST, so every
 * expression Marko already parsed has to become code again. Marko bundles its
 * own Babel and these nodes belong to that instance, so its generator is the
 * one that can print them — the export is `generator`, not `generate`.
 */
function printExpression(node: unknown): string {
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

void TranslateError;
