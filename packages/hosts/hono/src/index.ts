import { readFileSync } from "node:fs";
import {
  type CompilePreactOptions,
  type CompilePreactResult,
  type CompileResult,
  compilePreactMx,
  type RawSourceMap,
} from "@mxlang/preact";
import { honoDeclarations, honoTarget } from "./target.ts";

export { TranslateError } from "@mxlang/preact";
export { honoDeclarations, honoTarget } from "./target.ts";
export type { CompileResult, RawSourceMap };

/** Compiles a whole-file MX template to a Hono JSX component module. */
export function compileHonoMx(
  source: string,
  filename: string,
  options: Pick<CompilePreactOptions, "customTags"> = {},
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    target: honoTarget,
    declarations: honoDeclarations,
    customTags: options.customTags,
  });
}

/** `compileHonoMx()` over a file on disk. */
export function compileHonoFile(filename: string): CompileResult {
  return compileHonoMx(readFileSync(filename, "utf8"), filename);
}
