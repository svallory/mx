/**
 * The stdio transport: wires `diagnoseDocument` (see `diagnose.ts`) and
 * `resolveHostPolicy` (see `resolve-policy.ts`) into a `vscode-languageserver`
 * connection.
 *
 * Diagnostics only (decision 71/72): `textDocumentSync` is the one
 * capability advertised. No completion, hover, or go-to-definition — Marko's
 * own language server keeps those; this server exists only to surface the
 * host-policy errors Marko's server cannot see (`host-diagnostics.md` §1,
 * `<let>` under a strict policy being valid Marko syntax and therefore
 * invisible to it).
 */

import { fileURLToPath } from "node:url";
import {
  createConnection,
  type Diagnostic,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { diagnoseDocument, isSolidMxDocument } from "./diagnose.ts";
import { resolveHostPolicy } from "./resolve-policy.ts";

/** Milliseconds to wait after the last edit before compiling (brief §3). */
const DEBOUNCE_MS = 150;

/**
 * The `languageId`s an editor may attach to an MX document. Checked in
 * addition to the file suffix, since some clients open a buffer with no
 * `file://` URI (e.g. `untitled:`) — the suffix check alone would miss it.
 */
const MX_LANGUAGE_IDS = new Set(["mx", "marko"]);

function isMxDocument(uri: string, languageId: string): boolean {
  return (
    isSolidMxDocument(uri, languageId) ||
    MX_LANGUAGE_IDS.has(languageId) ||
    uri.endsWith(".mx") ||
    uri.endsWith(".marko")
  );
}

/**
 * Starts the server on stdio. Returns the connection so a test can drive it
 * over an in-memory duplex instead (see `server.test.ts`).
 */
export function startServer(
  connectionFactory: () => ReturnType<typeof createConnection> = () =>
    createConnection(ProposedFeatures.all),
) {
  const connection = connectionFactory();
  const documents = new TextDocuments(TextDocument);

  // One pending debounce timer per document URI; a superseded run is
  // cancelled by clearing and replacing its timer, never by racing two
  // compiles for the same document.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleDiagnostics(uri: string, languageId: string, text: string) {
    if (!isMxDocument(uri, languageId)) return;

    const existing = pending.get(uri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(uri);
      let filePath = uri;
      try {
        // `fileURLToPath`, not `new URL(uri).pathname`: the latter leaves
        // `%20` etc. percent-encoded and, on Windows, yields a leading-slash
        // form (`/C:/Users/...`) neither `path.join` nor `path.dirname`
        // treats as that drive's root — both would make the package.json
        // walk in resolve-policy.ts silently find nothing and fall back to
        // the default policy instead of the file's real one.
        filePath = fileURLToPath(uri);
      } catch {
        // Not a file:// URI (e.g. untitled:); resolvePolicyObject/Diagnose
        // work fine on the raw string, they only use it for messages and,
        // for policy resolution, an upward directory walk that will simply
        // find nothing and fall back to the default.
      }

      const hostPolicy = resolveHostPolicy(filePath);
      const diagnostics: Diagnostic[] = diagnoseDocument(
        text,
        uri,
        hostPolicy,
        (error) =>
          connection.console.error(
            `@mxlang/language-server: unexpected error compiling ${uri}: ${String(error)}`,
          ),
        languageId,
      );
      connection.sendDiagnostics({ uri, diagnostics });
    }, DEBOUNCE_MS);

    pending.set(uri, timer);
  }

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  }));

  documents.onDidOpen((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
  });

  documents.onDidChangeContent((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
  });

  documents.onDidSave((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
  });

  documents.onDidClose((event) => {
    const timer = pending.get(event.document.uri);
    if (timer) {
      clearTimeout(timer);
      pending.delete(event.document.uri);
    }
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  documents.listen(connection);
  connection.listen();

  return connection;
}

export { isMxDocument, MX_LANGUAGE_IDS };
