import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  type Expr,
  type Ir,
  type IrNode,
  type Lookup,
  type Node,
  newCtx,
  parseFragment,
  resolve,
  resolveHostPolicy,
} from "@mxlang/core";
import { compile, policy, strictPolicy, translator } from "@mxlang/html";
import { compileSolidMx } from "@mxlang/solid";
import type {
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import { codeInformation, decodeMappings, mergeMappings } from "./language.ts";

export const MX_LANGUAGE_ID = "mx";
export const MX_EXTENSIONS = ["mx", "marko"] as const;

export interface MxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface MxLanguagePlugin extends LanguagePlugin<string> {
  getSyntaxError(fileName: string): MxSyntaxError | undefined;
}

export function createMxLanguagePlugin(
  typescript: typeof ts,
): MxLanguagePlugin {
  const syntaxErrors = new Map<string, MxSyntaxError>();

  return {
    getLanguageId(fileName) {
      return isMx(fileName) ? MX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== MX_LANGUAGE_ID && !isMx(fileName)) return undefined;

      const source = snapshot.getText(0, snapshot.getLength());
      try {
        const hostPolicy = resolveHostPolicy(fileName);
        const compiled =
          hostPolicy.host === "solid"
            ? compileSolidMx(source, { filename: fileName })
            : compile(source, fileName, {
                strict:
                  hostPolicy.host === "astro" || hostPolicy.strict === true,
              });
        const generated =
          hostPolicy.host === "astro"
            ? createAstroTypeSurface(compiled.code)
            : compiled.code;
        const mappings =
          hostPolicy.host === "solid"
            ? decodeMappings(compiled.map, generated, source)
            : createHtmlMappings(
                source,
                fileName,
                generated,
                hostPolicy.host === "astro" || hostPolicy.strict === true,
              );
        syntaxErrors.delete(fileName);
        return createVirtualCode(typescript, generated, mappings);
      } catch (cause) {
        syntaxErrors.set(fileName, toSyntaxError(fileName, source, cause));
        return createVirtualCode(typescript, "", []);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: MX_EXTENSIONS.map((extension) => ({
        extension,
        isMixedContent: false,
        scriptKind: typescript.ScriptKind.TS,
      })),
      getServiceScript(root) {
        return {
          code: root,
          extension: ".ts",
          scriptKind: typescript.ScriptKind.TS,
          // Deliberately no `preventLeadingOffset`. A compiled `.mx` module
          // does not preserve the source's line structure (the `escape` import
          // and the hoisted statements move), and with that flag set Volar's
          // `runTsc` parses its `SourceFile` from the generated text alone —
          // so `tsc` turns a correctly mapped source *offset* into line/column
          // using the generated file's line table, reporting every `.mx`
          // diagnostic on the wrong line. Unset, Volar pads the virtual
          // contents to the source's own lines and the offsets agree.
        };
      },
    },
  };
}

/**
 * Astro passes template children as JSX's `children` attribute, then the MX
 * renderer turns that slot into `input.content` at runtime. Present that call
 * shape to TypeScript without changing the compiled function body.
 */
export function createAstroTypeSurface(code: string): string {
  const defaultExport = "export default render;";
  if (!code.includes(defaultExport)) {
    throw new Error(
      "@mxlang/typescript-plugin: the Astro host could not find the compiled MX default export.",
    );
  }
  return code.replace(
    defaultExport,
    [
      'type MxAstroInput = Omit<Input, "content"> & { children?: unknown };',
      "const mxAstroRender = render as unknown as (input: MxAstroInput) => string;",
      "export default mxAstroRender;",
    ].join("\n"),
  );
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  mappings: CodeMapping[],
): VirtualCode {
  return {
    id: "root",
    languageId: "typescript",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings,
    embeddedCodes: [],
  };
}

/**
 * The HTML compiler currently returns an empty placeholder source map. Build
 * the mappings from the same positioned IR expressions its emitter consumes:
 * every expression carries its original Babel node (and exact `loc`) plus the
 * source text emitted into the TypeScript module.
 */
export function createHtmlMappings(
  source: string,
  fileName: string,
  generated: string,
  strict: boolean,
): CodeMapping[] {
  const require = createRequire(import.meta.url);
  const compiler = require("@marko/compiler") as {
    taglib: {
      buildLookup(directory: string, translator: unknown): Lookup | undefined;
    };
  };
  const { generator } = require("@marko/compiler/internal/babel") as {
    generator(node: Node, options: { concise: boolean }): { code: string };
  };
  const { body } = parseFragment(source, { filename: fileName });
  const ctx = newCtx(
    source,
    (node) => generator(node, { concise: true }).code,
    strict ? strictPolicy : policy,
    compiler.taglib.buildLookup(dirname(fileName), translator),
  );
  const ir = resolve(ctx, body);
  const mappedCode = collectMappedCode(ir);
  const sourceLines = lineOffsets(source);
  const mappings: CodeMapping[] = [];
  let generatedCursor = 0;
  const generatedCodeCursors = new Map<string, number>();

  for (const item of mappedCode) {
    const sourceRange = locateSourceCode(item, source, sourceLines);
    if (!sourceRange || item.code.length === 0) continue;

    const searchFrom = Math.max(
      generatedCursor,
      generatedCodeCursors.get(item.code) ?? 0,
    );
    const generatedOffset = generated.indexOf(item.code, searchFrom);
    if (generatedOffset < 0) continue;
    generatedCursor = generatedOffset + item.code.length;
    generatedCodeCursors.set(item.code, generatedCursor);
    mappings.push({
      sourceOffsets: [sourceRange.offset],
      generatedOffsets: [generatedOffset],
      lengths: [sourceRange.length],
      ...(sourceRange.length === item.code.length
        ? {}
        : { generatedLengths: [item.code.length] }),
      data: codeInformation,
    });
  }

  return mergeMappings(
    mappings.sort(
      (left, right) =>
        (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
    ),
  );
}

type PositionedCode =
  | Expr
  | Extract<
      IrNode,
      {
        kind: "Static" | "Import" | "Export" | "InputInterface" | "Hoisted";
      }
    >;

function collectMappedCode(ir: Ir): PositionedCode[] {
  const mapped: PositionedCode[] = [];
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isExpression(value)) {
      mapped.push(value);
      return;
    }
    if (isPositionedCode(value)) {
      mapped.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "node") visit(child);
    }
  }

  visit(ir);
  return mapped;
}

function isExpression(value: object): value is Expr {
  const candidate = value as Partial<Expr>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.shape === "string" &&
    !!candidate.node
  );
}

function isPositionedCode(
  value: object,
): value is Exclude<PositionedCode, Expr> {
  const candidate = value as Partial<Exclude<PositionedCode, Expr>>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.kind === "string" &&
    ["Static", "Import", "Export", "InputInterface", "Hoisted"].includes(
      candidate.kind,
    ) &&
    !!candidate.loc &&
    !!candidate.end
  );
}

function locateSourceCode(
  item: PositionedCode,
  source: string,
  sourceLines: number[],
): { offset: number; length: number } | undefined {
  if (isExpression(item)) {
    const loc = item.node?.loc;
    if (!loc?.start || !loc.end) return undefined;
    const offset = offsetAt(sourceLines, source.length, loc.start);
    const end = offsetAt(sourceLines, source.length, loc.end);
    return source.slice(offset, end) === item.code
      ? { offset, length: item.code.length }
      : undefined;
  }

  const blockStart = offsetAt(sourceLines, source.length, item.loc);
  const blockEnd = offsetAt(sourceLines, source.length, item.end);
  const withinBlock = source.slice(blockStart, blockEnd).indexOf(item.code);
  if (withinBlock >= 0) {
    return { offset: blockStart + withinBlock, length: item.code.length };
  }

  // A host hook may synthesize a hoisted declaration from a source tag. Map
  // the generated declaration as one block to the producing tag's full span;
  // this is deliberately approximate, but keeps its diagnostics visible.
  if (item.kind === "Hoisted" && blockEnd > blockStart) {
    return { offset: blockStart, length: blockEnd - blockStart };
  }
  return undefined;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}

function offsetAt(
  offsets: number[],
  sourceLength: number,
  position: { line: number; column: number },
): number {
  return Math.min(
    sourceLength,
    (offsets[Math.max(0, position.line - 1)] ?? sourceLength) +
      Math.max(0, position.column),
  );
}

function isMx(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".solid.mx")) return false;
  return MX_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): MxSyntaxError {
  const error = cause as {
    message?: string;
    line?: number;
    column?: number;
    loc?: {
      line?: number;
      column?: number;
      start?: { line?: number; column?: number };
    };
  };
  const line = Math.max(
    1,
    error.line ?? error.loc?.line ?? error.loc?.start?.line ?? 1,
  );
  const column = Math.max(
    0,
    error.column ?? error.loc?.column ?? error.loc?.start?.column ?? 0,
  );
  const offset = (lineOffsets(source)[line - 1] ?? source.length) + column;
  return {
    fileName,
    message: error.message ?? "Invalid MX source.",
    offset: Math.min(source.length, offset),
    source,
  };
}
