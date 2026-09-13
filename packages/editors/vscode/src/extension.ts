import type { ExtensionContext } from "vscode";
import { commands, window, workspace } from "vscode";
import type {
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { LanguageClient } from "vscode-languageclient/node";
import { getServerCommand } from "./server-command.js";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel("MX Language Server");

  const startClient = async () => {
    try {
      const config = workspace.getConfiguration("mxlang");
      const configuredPath = config.get<string>("languageServer.path");
      const workspaceFolders = (workspace.workspaceFolders || []).map(
        (f) => f.uri.fsPath,
      );

      const serverCommand = getServerCommand(configuredPath, workspaceFolders);
      const serverOptions: ServerOptions = {
        run: serverCommand,
        debug: serverCommand,
      };

      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          { scheme: "file", language: "mx" },
          { scheme: "untitled", language: "mx" },
          { scheme: "file", language: "solidmx" },
          { scheme: "untitled", language: "solidmx" },
          // astromx is intentionally excluded as the LS does not handle .amx yet
        ],
        // biome-ignore lint/suspicious/noExplicitAny: reason
        outputChannel: outputChannel as any,
      };

      client = new LanguageClient(
        "mxlang",
        "MX Language Server",
        serverOptions,
        clientOptions,
      );

      await client.start();
      // biome-ignore lint/suspicious/noExplicitAny: reason
    } catch (e: any) {
      outputChannel.appendLine(`Failed to start language server: ${e.message}`);
    }
  };

  startClient();

  const restartCommand = commands.registerCommand(
    "mxlang.restartLanguageServer",
    async () => {
      if (client) {
        await client.stop();
      }
      await startClient();
    },
  );

  context.subscriptions.push(restartCommand);
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
