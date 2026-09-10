import { createRequire } from "node:module";
import { emitProgram, TranslateError } from "./translate.ts";

export { escape } from "./escape.ts";
export { TranslateError } from "./translate.ts";

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
 * Compiles a whole-file `.mx` template to a TypeScript module.
 *
 * `@marko/compiler` parses, validates and supplies the tag registry (ADR 0001);
 * this package supplies only the translator. The emitted module imports
 * `escape` from here and default-exports `(input: Input) => string` — nothing
 * else is required at runtime.
 *
 * The returned map is a placeholder identity map: the translator builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from yet. The shape is fixed now so the signature does
 * not change when they land.
 */
export function compile(source: string, filename: string): CompileResult {
  // Required lazily and by CJS: `@marko/compiler` is a large dependency and
  // only `compile()` needs it, so importing `escape` stays free.
  const compiler = require("@marko/compiler");

  let code: string | null = null;

  const translator = {
    taglibs: [["mx-html", require("../taglib/marko.json")]],
    tagDiscoveryDirs: [],
    translate: {
      Program: {
        exit(path: {
          node: { body: unknown[] };
          hub: { file: { code: string } };
        }) {
          code = emitProgram(path.node.body, source, printExpression);
          path.node.body = [];
        },
      },
    },
  };

  try {
    compiler.compileSync(source, filename, {
      translator,
      output: "html",
      writeVersionComment: false,
    });
  } catch (error) {
    if (error instanceof TranslateError) throw error;
    throw error;
  }

  if (code === null) {
    throw new Error(`${filename}: translator produced no output`);
  }

  return {
    code,
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
