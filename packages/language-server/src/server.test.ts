import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageConnection,
  type MessageConnection,
  NotificationType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

/**
 * The one stdio end-to-end test the brief asks for (§5): spawn the real
 * `dist/bin.js` over stdio, `initialize`, `didOpen` a document that a strict
 * policy rejects, and wait for the resulting `publishDiagnostics`
 * notification — proving the whole transport, not just `diagnoseDocument`.
 *
 * Requires `bun run build` to have produced `dist/bin.js` (see AGENTS.md
 * "Running tests in a fresh worktree" — the root `verify` script builds
 * before it tests, so this only bites a package run standalone).
 */

const BIN_PATH = join(import.meta.dirname, "../dist/bin.js");

const PublishDiagnosticsNotification = new NotificationType<{
  uri: string;
  diagnostics: Array<{ message: string; source?: string }>;
}>("textDocument/publishDiagnostics");

let child: ChildProcess | undefined;
let connection: MessageConnection | undefined;

afterEach(() => {
  connection?.dispose();
  connection = undefined;
  // The load rule requires killing what a test starts.
  child?.kill();
  child = undefined;
});

function startClient(): MessageConnection {
  child = spawn("bun", ["run", BIN_PATH, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stdin) {
    throw new Error("failed to open the server's stdio streams");
  }
  connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  return connection;
}

describe("stdio server (e2e)", () => {
  it("publishes a diagnostic for a strict-policy document opened over stdio", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        resolve(params);
      });
    });

    // This file's nearest package.json (fixtures/explicit-field) declares
    // `"mxlang": { "host": "astro", "strict": true }`, which resolves to the
    // translator's strictPolicy — under which <let> is a compile error.
    const uri = `file://${join(import.meta.dirname, "fixtures/explicit-field/nested/App.mx")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });

    const params = await diagnosticsReceived;

    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.source).toBe("mxlang");
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);

  it("resolves the policy correctly for a file:// URI with a percent-encoded space in its path", async () => {
    // Regression for the `new URL(uri).pathname` bug: that API leaves
    // `%20` percent-encoded, so the package.json walk in resolve-policy.ts
    // would look for a directory literally named "space%20in%20name" and
    // find nothing, silently falling back to the default (non-strict)
    // policy instead of this fixture's strict one. `fileURLToPath` decodes
    // it, so the walk finds the real "space in name" directory.
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        resolve(params);
      });
    });

    const filePath = join(import.meta.dirname, "fixtures/space in name/App.mx");
    const uri = `file://${filePath.replaceAll(" ", "%20")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });

    const params = await diagnosticsReceived;

    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);
});
