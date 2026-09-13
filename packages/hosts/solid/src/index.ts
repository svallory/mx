import generate from "@babel/generator";
import { parse as parseBabel } from "@babel/parser";
import {
  type Node,
  type GeneratedMapping,
  newCtx,
  parseFragment,
  resolve,
  TranslateError,
} from "@mxlang/core";
import MagicString from "magic-string";
import {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  SolidEmitter,
  solidDeclarations,
} from "./emitter.ts";

export {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  SolidEmitter,
  solidDeclarations,
};

export interface CompileSolidMxOptions {
  filename: string;
  /** File-relative position of this region; used by the parser bridge. */
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
}

export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompileSolidMxResult {
  code: string;
  map: RawSourceMap;
  mappings: GeneratedMapping[];
}

/**
 * `@babel/generator` ships as CJS with an interop default; under
 * `esModuleInterop` the namespace can arrive as either the function itself or
 * a `{ default }` wrapper depending on the loader. Normalize once.
 */
const generator = (
  typeof generate === "function"
    ? generate
    : (generate as { default: typeof generate }).default
) as typeof generate;

function generateExpression(node: Node): string {
  return generator(node, { concise: true }).code;
}

/**
 * Marko parses attribute-method bodies as ordinary TypeScript, where a nested
 * JSX/MX expression is reported as a `MarkoParseError` statement. SolidMX's
 * surrounding language is TSX, so retry only those statement-shaped failures
 * with Babel's TSX parser. Genuine expression failures remain untouched and
 * are reported by the core with Marko's precise `errorLoc`.
 */
function repairEmbeddedTsx(node: Node, seen = new Set<object>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      const item = node[index];
      if (item?.type === "MarkoParseError" && typeof item.source === "string") {
        try {
          const parsed = parseBabel(item.source, {
            sourceType: "module",
            plugins: ["typescript", "jsx"],
            allowReturnOutsideFunction: true,
          });
          node.splice(index, 1, ...parsed.program.body);
          index += parsed.program.body.length - 1;
          continue;
        } catch {
          // The core reports the original MarkoParseError below this pass.
        }
      }
      repairEmbeddedTsx(item, seen);
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "extra") continue;
    repairEmbeddedTsx(node[key], seen);
  }
}

/**
 * Compiles one MX markup region to Solid JSX text.
 *
 * A `.solid.mx` file remains an ordinary TypeScript module. The parser owns
 * discovery of each markup region and calls this function with the region
 * text and its file-relative base position; the result is parsed back as JSX
 * before the surrounding TypeScript AST is returned.
 */
export function compileSolidMx(
  source: string,
  options: CompileSolidMxOptions,
): CompileSolidMxResult {
  const baseOffset = options.baseOffset ?? 0;
  const { body } = parseFragment(source, {
    filename: options.filename,
    baseOffset,
    baseLine: options.baseLine ?? 0,
    baseColumn: options.baseColumn ?? 0,
  });
  repairEmbeddedTsx(body);
  const positionedSource = `${"\n".repeat(options.baseLine ?? 0)}${" ".repeat(options.baseColumn ?? 0)}${source}`;
  const ctx = newCtx(positionedSource, generateExpression, solidDeclarations);
  const ir = resolve(ctx, body);
  if (
    ir.imports.length > 0 ||
    ir.hoisted.length > 0 ||
    ir.inputInterface !== null ||
    ir.prelude.length > 0
  ) {
    throw new TranslateError(
      "module-level MX statements cannot appear inside a `.solid.mx` expression; write them in the surrounding TypeScript module",
      (options.baseLine ?? 0) + 1,
      options.baseColumn ?? 0,
    );
  }
  const emitted = emitSolidWithMappings(ir);
  const code = emitted.code;
  const rewritten = new MagicString(source);
  rewritten.overwrite(0, source.length, code);
  const map = rewritten.generateMap({
    file: options.filename,
    source: options.filename,
    includeContent: true,
    hires: true,
  });
  return { code, map: map as RawSourceMap, mappings: emitted.mappings };
}
