/**
 * The server's core function: compile one document under a resolved host
 * policy and turn the result into LSP diagnostics.
 *
 * Kept independent of any transport (stdio, in-process duplex) so it can be
 * tested directly, as the brief requires, without spawning a process.
 */

import { compileSource, TranslateError } from "@mxlang/core";
import { policy, strictPolicy } from "@mxlang/translator";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

export interface HostPolicy {
  host: "translator" | "astro" | "solid";
  strict?: boolean;
}

/**
 * Resolves a `HostPolicy` to the `@mxlang/core` `Policy` object that compiles
 * it. Only `"translator"` is wired to a real host today (`@mxlang/astro` and
 * a future SolidMX host both build on `@mxlang/core` but do not yet export a
 * `Policy` a caller outside their own package can import — see the "host"
 * union above and README "Adding a host" for the extension point).
 */
function resolvePolicyObject(hostPolicy: HostPolicy) {
  switch (hostPolicy.host) {
    case "astro":
      // `@mxlang/astro` always compiles under the translator's strictPolicy
      // (decision 71: astro-static ships no stateful tags).
      return strictPolicy;
    case "solid":
      // SolidMX is paused (decision 58) and has no core-based Policy yet;
      // fall back to the translator's policy rather than throwing, so a
      // mixed workspace still gets diagnostics for its non-Solid files.
      return hostPolicy.strict ? strictPolicy : policy;
    default:
      return hostPolicy.strict ? strictPolicy : policy;
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
  const policyObject = resolvePolicyObject(hostPolicy);

  try {
    compileSource(text, uri, policyObject, {});
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
