/**
 * The server's core function: compile one document under a resolved host
 * policy and turn the result into LSP diagnostics.
 *
 * Kept independent of any transport (stdio, in-process duplex) so it can be
 * tested directly, as the brief requires, without spawning a process.
 */

import { type HostPolicy, TranslateError } from "@mxlang/core";
import { compile } from "@mxlang/html";
import { parse } from "@mxlang/parser";
import { compilePreactMx } from "@mxlang/preact";
import { compileSolidMx } from "@mxlang/solid";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

export type { HostPolicy };

export const SOLID_MX_LANGUAGE_IDS = new Set(["solidmx", "SolidMX"]);

export function isSolidMxDocument(uri: string, languageId = ""): boolean {
  return uri.endsWith(".solid.mx") || SOLID_MX_LANGUAGE_IDS.has(languageId);
}

/**
 * Resolves a `HostPolicy` to the `strict` flag the translator compiles under.
 *
 * Solid and Preact documents take their own compiler path before this
 * function is called. Astro is always strict; HTML follows the resolved
 * policy.
 */
function resolveStrict(hostPolicy: HostPolicy): boolean {
  if (hostPolicy.host === "astro") return true;
  return hostPolicy.strict ?? false;
}

function errorPosition(
  error: unknown,
): { line: number; column: number } | null {
  if (error instanceof TranslateError) {
    return { line: error.line, column: error.column };
  }
  if (!error || typeof error !== "object") return null;

  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== "object") return null;

  const direct = loc as { line?: unknown; column?: unknown };
  if (typeof direct.line === "number" && typeof direct.column === "number") {
    return { line: direct.line, column: direct.column };
  }

  const start = (loc as { start?: unknown }).start;
  if (!start || typeof start !== "object") return null;
  const nested = start as { line?: unknown; column?: unknown };
  if (typeof nested.line === "number" && typeof nested.column === "number") {
    return { line: nested.line, column: nested.column };
  }
  return null;
}

/**
 * Compiles or parses `text` for its document kind and returns the diagnostics
 * to publish for `uri`. Never throws: a positioned error becomes one Error
 * diagnostic; a successful run returns `[]`, which clears any previous
 * diagnostics; a locationless exception is reported via `onUnexpectedError`
 * and also returns `[]`.
 */
export function diagnoseDocument(
  text: string,
  uri: string,
  hostPolicy: HostPolicy,
  onUnexpectedError?: (error: unknown) => void,
  languageId = "",
): Diagnostic[] {
  try {
    if (isSolidMxDocument(uri, languageId)) {
      // `parse` is the Vite path's whole-file parser and the cheapest public
      // entry that discovers every MX region. A language id can identify an
      // untitled/mis-suffixed buffer, so give that case the suffix that turns
      // the parser's opt-in MX bridge on.
      const filename = uri.endsWith(".solid.mx") ? uri : `${uri}.solid.mx`;
      parse(text, filename);
    } else if (hostPolicy.host === "solid") {
      // A whole-file `.mx` document routed to the Solid host uses the same
      // fixed Solid profile as an embedded region. Its declarations reject
      // stateful Marko tags; there is no looser Solid policy to select.
      compileSolidMx(text, { filename: uri });
    } else if (hostPolicy.host === "preact") {
      // A whole-file `.mx` document routed to the Preact host. Its
      // declarations reject Marko's stateful tags outright, so like Solid's
      // there is no looser policy to select — the `strict` flag has no
      // meaning for this host and is not consulted.
      compilePreactMx(text, uri);
    } else {
      // Through `@mxlang/html`'s own front door, not `compileSource`
      // directly: this registers the host taglib and compiles via the IR.
      compile(text, uri, { strict: resolveStrict(hostPolicy) });
    }
    return [];
  } catch (error) {
    const position = errorPosition(error);
    if (position) {
      // Babel/core lines are 1-based and columns are 0-based. LSP positions
      // are 0-based on both axes.
      const line = Math.max(0, position.line - 1);
      const column = Math.max(0, position.column);
      // These errors carry only a start position, not a span, so synthesize a
      // one-character range that marks where the error occurred.
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        source: "mxlang",
        message:
          error instanceof Error
            ? error.message
            : String((error as { message?: unknown }).message ?? error),
        range: {
          start: { line, character: column },
          end: { line, character: column + 1 },
        },
      };
      return [diagnostic];
    }

    onUnexpectedError?.(error);
    return [];
  }
}
