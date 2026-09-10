import type { RawSourceMap } from "@markox/parser";
import { parse } from "@markox/parser";
import { emitTemplate } from "./emit.ts";

export { EmitError } from "./emit.ts";
export { escape } from "./escape.ts";
export type { RawSourceMap };

export interface CompileResult {
  code: string;
  map: RawSourceMap;
}

/**
 * Compiles a whole-file `.mx` template to a TypeScript module.
 *
 * The emitted module imports `escape` from this package and default-exports
 * `(input: Input) => string`. Nothing else is required at runtime — see
 * `emit.ts` for the module shape and `escape.ts` for the entire runtime.
 *
 * The returned map is a placeholder identity map. The emitter builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from; wiring those is a separate task, and the shape is
 * fixed now so the signature does not change when it lands.
 */
export function compile(source: string, filename: string): CompileResult {
  const file = parse(source, filename, { mxMode: "template" });
  const template = file.extra?.mxTemplate;
  if (!template) {
    throw new Error(
      `${filename}: parse produced no template; was mxMode "template" honoured?`,
    );
  }

  const code = emitTemplate(template, source);

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
