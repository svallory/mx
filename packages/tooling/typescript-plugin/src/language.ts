import { decode } from "@jridgewell/sourcemap-codec";
import { print, type RawSourceMap } from "@mxlang/parser";
import type {
  CodeInformation,
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";

export const SOLID_MX_EXTENSION = "solid.mx";
export const SOLID_MX_LANGUAGE_ID = "solidmx";

const codeInformation: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
};

export interface SolidMxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface SolidMxLanguagePlugin extends LanguagePlugin<string> {
  getSyntaxError(fileName: string): SolidMxSyntaxError | undefined;
}

export function createSolidMxLanguagePlugin(
  typescript: typeof ts,
): SolidMxLanguagePlugin {
  const syntaxErrors = new Map<string, SolidMxSyntaxError>();

  return {
    getLanguageId(fileName) {
      return isSolidMx(fileName) ? SOLID_MX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== SOLID_MX_LANGUAGE_ID && !isSolidMx(fileName)) {
        return undefined;
      }

      const source = snapshot.getText(0, snapshot.getLength());
      try {
        const printed = print(source, fileName);
        syntaxErrors.delete(fileName);
        return createVirtualCode(typescript, printed.code, source, printed.map);
      } catch (cause) {
        syntaxErrors.set(fileName, toSyntaxError(fileName, source, cause));
        return createVirtualCode(typescript, "", source, undefined);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: [
        {
          extension: SOLID_MX_EXTENSION,
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript(root) {
        return {
          code: root,
          extension: ".tsx",
          scriptKind: typescript.ScriptKind.TSX,
          preventLeadingOffset: true,
        };
      },
    },
  };
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  source: string,
  map: RawSourceMap | undefined,
): VirtualCode {
  return {
    id: "root",
    languageId: "typescriptreact",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings: map ? decodeMappings(map, generated, source) : [],
    embeddedCodes: [],
  };
}

export function decodeMappings(
  map: RawSourceMap,
  generated: string,
  source: string,
): CodeMapping[] {
  const generatedLineOffsets = lineOffsets(generated);
  const sourceLineOffsets = lineOffsets(source);
  const mappings: CodeMapping[] = [];

  for (const [generatedLine, segments] of decode(map.mappings).entries()) {
    const generatedLineOffset = generatedLineOffsets[generatedLine];
    if (generatedLineOffset === undefined) continue;

    for (const segment of segments) {
      if (segment.length < 4) continue;
      const sourceLine = segment[2];
      const sourceColumn = segment[3];
      if (sourceLine === undefined || sourceColumn === undefined) continue;
      const sourceLineOffset = sourceLineOffsets[sourceLine];
      if (sourceLineOffset === undefined) continue;

      const generatedOffset = generatedLineOffset + segment[0];
      const sourceOffset = sourceLineOffset + sourceColumn;
      const length = equalLength(
        generated,
        generatedOffset,
        source,
        sourceOffset,
      );
      if (length === 0) continue;

      mappings.push({
        sourceOffsets: [sourceOffset],
        generatedOffsets: [generatedOffset],
        lengths: [length],
        data: codeInformation,
      });
    }
  }

  return mappings;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}

function equalLength(
  generated: string,
  generatedOffset: number,
  source: string,
  sourceOffset: number,
): number {
  let length = 0;
  while (
    generatedOffset + length < generated.length &&
    sourceOffset + length < source.length &&
    generated.charCodeAt(generatedOffset + length) ===
      source.charCodeAt(sourceOffset + length)
  ) {
    length++;
  }
  return length;
}

function isSolidMx(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`.${SOLID_MX_EXTENSION}`);
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): SolidMxSyntaxError {
  const error = cause as {
    message?: string;
    loc?: { line?: number; column?: number; index?: number };
  };
  const line = Math.max(1, error.loc?.line ?? 1);
  const column = Math.max(0, error.loc?.column ?? 0);
  const lineStart = lineOffsets(source)[line - 1] ?? source.length;

  return {
    fileName,
    message: error.message ?? "Invalid SolidMX source.",
    offset: Math.min(source.length, error.loc?.index ?? lineStart + column),
    source,
  };
}
