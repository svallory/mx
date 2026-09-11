/**
 * The server's core function: compile one document under a resolved host
 * policy and turn the result into LSP diagnostics.
 *
 * Kept independent of any transport (stdio, in-process duplex) so it can be
 * tested directly, as the brief requires, without spawning a process.
 */

import { TranslateError } from "@mxlang/core";
import { compile } from "@mxlang/translator";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

export interface HostPolicy {
  host: "translator" | "astro" | "solid";
  strict?: boolean;
}

/**
 * Resolves a `HostPolicy` to the `strict` flag the translator compiles under.
 *
 * Only `"translator"` is wired to a real host today (`@mxlang/astro` and a
 * future SolidMX host both build on `@mxlang/core` but do not yet export a
 * host a caller outside their own package can drive — see the "host" union
 * above and README "Adding a host" for the extension point).
 */
function resolveStrict(hostPolicy: HostPolicy): boolean {
  switch (hostPolicy.host) {
    case "astro":
      // `@mxlang/astro` always compiles under the strict policy (decision 71:
      // astro-static ships no stateful tags), whatever the field says.
      return true;
    case "solid":
      // SolidMX is paused (decision 58) and has no core-based host yet; fall
      // back to the translator's own default rather than throwing, so a mixed
      // workspace still gets diagnostics for its non-Solid files.
      return hostPolicy.strict ?? false;
    default:
      return hostPolicy.strict ?? false;
  }
}

/**
 * Compiles `text` under `hostPolicy` and returns the diagnostics to publish
 * for `uri`. Never throws: a `TranslateError` (with `line`/`column`) becomes
 * one Error diagnostic; a successful compile returns `[]`, which the caller
 * publishes to clear any previous diagnostics; any other, unexpected
 * exception is swallowed here and reported via `onUnexpectedError` so the
 * caller can log it without ever publishing a stale or wrong diagnostic set.
 */
export function diagnoseDocument(
  text: string,
  uri: string,
  hostPolicy: HostPolicy,
  onUnexpectedError?: (error: unknown) => void,
): Diagnostic[] {
  // Through `@mxlang/translator`'s own front door, not `compileSource`
  // directly: `compile()` registers the host's taglib and compiles via the
  // IR (`HostOptions.emitIr`), which is what makes `<let>` and the other
  // tags this host claims resolve at all. Driving `compileSource` with an
  // empty host took the core's legacy string walk instead, where those tags
  // are not handled — the diagnostics would then report a construct as an
  // unknown tag purely because the language server compiled it differently
  // from the way the host actually does.
  try {
    compile(text, uri, { strict: resolveStrict(hostPolicy) });
    return [];
  } catch (error) {
    if (error instanceof TranslateError) {
      // `line` is 1-based, `column` is 0-based (Babel's convention, which
      // TranslateError's constructor passes through unchanged from `fail()`
      // in @mxlang/core). LSP positions are 0-based on both axes.
      const line = Math.max(0, error.line - 1);
      const column = Math.max(0, error.column);
      // TranslateError carries only a start position, not a span, so the
      // end column is synthesized as start + 1 — a one-character range
      // that marks *where* the error is, not the extent of what caused it.
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        source: "mxlang",
        message: error.message,
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
