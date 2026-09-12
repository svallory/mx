import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  type Expr,
  type Ir,
  type Lookup,
  type Node,
  newCtx,
  parseFragment,
  resolve,
} from "@mxlang/core";
import {
  compile,
  policy,
  strictPolicy,
  translator,
} from "@mxlang/html";
import { compileSolidMx } from "@mxlang/solid";
import type {
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import {
  codeInformation,
  decodeMappings,
  mergeMappings,
} from "./language.ts";
import { resolveHostPolicy } from "./resolve-policy.ts";

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
        const mappings =
          hostPolicy.host === "solid"
            ? decodeMappings(compiled.map, compiled.code, source)
            : createHtmlMappings(
                source,
                fileName,
                compiled.code,
                hostPolicy.host === "astro" || hostPolicy.strict === true,
              );
        syntaxErrors.delete(fileName);
        return createVirtualCode(typescript, compiled.code, mappings);
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
          preventLeadingOffset: true,
        };
      },
    },
  };
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
  const expressions = collectExpressions(ir);
  const sourceLines = lineOffsets(source);
  const mappings: CodeMapping[] = [];
  let generatedCursor = 0;

  for (const expression of expressions) {
    const loc = expression.node?.loc;
    if (!loc?.start || !loc.end || expression.code.length === 0) continue;
    const sourceOffset = offsetAt(sourceLines, source.length, loc.start);
    const sourceEnd = offsetAt(sourceLines, source.length, loc.end);
    if (source.slice(sourceOffset, sourceEnd) !== expression.code) continue;

    let generatedOffset = generated.indexOf(expression.code, generatedCursor);
    if (generatedOffset < 0) generatedOffset = generated.indexOf(expression.code);
    if (generatedOffset < 0) continue;
    generatedCursor = generatedOffset + expression.code.length;
    mappings.push({
      sourceOffsets: [sourceOffset],
      generatedOffsets: [generatedOffset],
      lengths: [expression.code.length],
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

function collectExpressions(ir: Ir): Expr[] {
  const expressions: Expr[] = [];
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isExpression(value)) {
      expressions.push(value);
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
  return expressions;
}

function isExpression(value: object): value is Expr {
  const candidate = value as Partial<Expr>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.shape === "string" &&
    !!candidate.node
  );
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
