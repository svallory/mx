import { readFileSync } from "node:fs";
import {
  type PluginObj,
  type TransformOptions,
  transformSync,
} from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import type { File } from "@babel/types";
import solidPreset from "babel-preset-solid";

export class MxParserUnavailable extends Error {
  constructor(filename: string) {
    super(`opts.mxParser was not provided; cannot compile ${filename}`);
    this.name = "MxParserUnavailable";
  }
}

export type SolidGenerate = "dom" | "ssr";

export interface SolidVariant {
  generate: SolidGenerate;
  hydratable: boolean;
}

export const VARIANTS: SolidVariant[] = [
  { generate: "dom", hydratable: false },
  { generate: "ssr", hydratable: true },
];

export type MxParser = (source: string, filename: string) => File;

export interface CompileOptions {
  mxParser?: MxParser;
}

/**
 * Compiles a single source file through babel-preset-solid for the given
 * variant. `.tsx` input goes through @babel/preset-typescript first.
 * `.solid.mx` input is parsed with `opts.mxParser` via Babel's
 * `parserOverride` hook (the same mechanism babel-plugin-mx will use).
 */
export function compile(
  source: string,
  filename: string,
  variant: SolidVariant,
  opts: CompileOptions = {},
): string {
  const isMx = filename.endsWith(".solid.mx");

  const plugins: TransformOptions["plugins"] = [];
  if (isMx) {
    if (!opts.mxParser) {
      throw new MxParserUnavailable(filename);
    }
    const mxParser = opts.mxParser;
    // @babel/core's PluginObj type doesn't model parserOverride, though it's
    // a real hook (same one @marko/compiler uses). Cast at the boundary.
    const overridePlugin = {
      name: "mx-oracle-parser-override",
      parserOverride(code: string) {
        return mxParser(code, filename);
      },
    } as unknown as PluginObj;
    plugins.push(overridePlugin);
  }

  // Both `.tsx` and `.solid.mx` sources may use TypeScript syntax (interfaces,
  // type annotations, generics); the vendored MX parser accepts that syntax
  // but does not strip it, so the TypeScript preset's erasure pass has to run
  // on the MX AST too, not just on `.tsx` input.
  const presets: TransformOptions["presets"] = [
    [typescriptPreset, { isTSX: true, allExtensions: true }],
    [
      solidPreset,
      { generate: variant.generate, hydratable: variant.hydratable },
    ],
  ];

  const result = transformSync(source, {
    filename,
    presets,
    plugins,
    babelrc: false,
    configFile: false,
  });

  if (!result?.code) {
    throw new Error(`Babel produced no output for ${filename}`);
  }

  return result.code;
}

export function compileFile(
  path: string,
  variant: SolidVariant,
  opts: CompileOptions = {},
): string {
  const source = readFileSync(path, "utf8");
  return compile(source, path, variant, opts);
}
