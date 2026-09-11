/**
 * `@mxlang/html` — MX's vanilla HTML host, on `@mxlang/core`.
 *
 * A `.mx` (or `.marko`) template becomes a pure `(input) => string` function:
 * no runtime beyond the `escape` helper, no framework. Everything generic —
 * the Marko-node consumer, the `config.translator` seam, the emit model —
 * lives in `@mxlang/core`; this package supplies the *policy* (`translate.ts`)
 * and the integrations (the Bun loader, the `escape` runtime, the taglib).
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  compileSource,
  createTranslator,
  type RawSourceMap,
} from "@mxlang/core";
import markoTaglib from "../taglib/marko.json" with { type: "json" };
import { emitModule } from "./emitter.ts";
import {
  escapeFrom,
  finalizeModule,
  policy,
  strictPolicy,
} from "./translate.ts";

export { escape } from "@mxlang/core";
export { policy, strictPolicy, TranslateError } from "./translate.ts";
export type { CompileResult, RawSourceMap };

/**
 * This host's options for the core's whole-file front door.
 *
 * `tagDiscoveryDirs: ["tags"]` is Marko's own convention, so a `.marko`/`.mx`
 * file in a `tags/` directory beside the template is callable as a tag with no
 * import — one of the things that makes this a host for *stock* Marko syntax
 * rather than for a dialect.
 *
 * `postEmit` is `translate.ts`'s `finalizeModule` wrapper, which appends the
 * `classValue`/`styleValue`/`escapeComment`/`renderDynamic` helpers a template
 * actually calls. It reaches the core as a hook rather than being folded into
 * the core's emitter because *which* helpers exist is this host's business.
 */
const host = {
  taglibs: [["mx-translator-core", markoTaglib]] as Array<[string, unknown]>,
  tagDiscoveryDirs: ["tags"],
};

/**
 * The Marko translator object, for `compile(src, file, { translator })`.
 *
 * Exported for a caller that drives `@marko/compiler` itself (the oracle's
 * stock-Marko comparison does). Built by the core, since the seam is the
 * core's.
 */
export const translator = createTranslator(host);

export interface CompileOptions {
  /**
   * Rejects reactive constructs (`<let>`, `<effect>`, `<lifecycle>`,
   * `<script>`, `client` blocks, `<id>`) by name instead of rendering their
   * initial value or treating them as inert. Folded from `.mx`'s dialect
   * (decision 68) as an opt-in stance for an author who wants those
   * constructs to be a compile error rather than silently accepted.
   */
  strict?: boolean;
}

/**
 * Compiles a `.mx`/`.marko` template to a runtime-free TypeScript module.
 *
 * The emitted module imports `escape` and default-exports
 * `(input: Input) => string` — nothing else is required at run time. This is
 * the "expressions-only" output mode of `notes/marko-runtime-modes.md`,
 * implemented as a translator rather than a fork.
 *
 * The returned map is a placeholder identity map: the emitter builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from yet.
 */
export function compile(
  source: string,
  filename: string,
  options: CompileOptions = {},
): CompileResult {
  return compileSource(
    source,
    filename,
    options.strict ? strictPolicy : policy,
    {
      ...host,
      // Decision 79: this host emits from the core's IR. `postEmit` still
      // appends the helpers a template actually calls and brands the default
      // export, both of which are properties of this target rather than of
      // the core.
      emitIr: (ir) => emitModule(ir, escapeFrom),
      postEmit: (code) => finalizeModule(code),
    },
  );
}

/** `compile()` over a file on disk. */
export function compileFile(
  filename: string,
  options: CompileOptions = {},
): CompileResult {
  return compile(readFileSync(filename, "utf8"), filename, options);
}

/**
 * Compiles a set of templates, returning the emitted module for each.
 *
 * The CLI-free equivalent of a build step: a caller writes the results
 * wherever its own pipeline wants them.
 */
export function build(
  filenames: string[],
  options: CompileOptions = {},
): Map<string, CompileResult> {
  const results = new Map<string, CompileResult>();
  for (const filename of filenames) {
    results.set(filename, compileFile(filename, options));
  }
  return results;
}
