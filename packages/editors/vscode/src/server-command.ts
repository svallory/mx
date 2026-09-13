import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Executable } from "vscode-languageclient/node";

export function which(command: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const output = execSync(`${cmd} ${command}`).toString();
    const firstLine = output.split("\n")[0];
    return firstLine ? firstLine.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function getServerCommand(
  configuredPath: string | undefined,
  workspaceFolders: string[],
): Executable {
  if (configuredPath) {
    return {
      command: configuredPath,
      args: ["--stdio"],
    };
  }

  // 1. Local install
  if (workspaceFolders && workspaceFolders.length > 0) {
    for (const folder of workspaceFolders) {
      const localMarker = path.join(
        folder,
        "node_modules",
        "@mxlang",
        "language-server",
        "package.json",
      );
      if (fs.existsSync(localMarker)) {
        const binName =
          process.platform === "win32"
            ? "mxlang-language-server.cmd"
            : "mxlang-language-server";
        return {
          command: path.join(folder, "node_modules", ".bin", binName),
          args: ["--stdio"],
        };
      }
    }
  }

  // 2. Global install
  const binName =
    process.platform === "win32"
      ? "mxlang-language-server.cmd"
      : "mxlang-language-server";
  const globalBin = which(binName);
  if (globalBin) {
    return {
      command: globalBin,
      args: ["--stdio"],
    };
  }

  // 3. bunx
  const bunxName = process.platform === "win32" ? "bunx.cmd" : "bunx";
  const bunx = which(bunxName);
  if (bunx) {
    return {
      command: bunx,
      args: ["@mxlang/language-server", "--stdio"],
    };
  }

  // 4. npx
  const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
  const npx = which(npxName);
  if (npx) {
    return {
      command: npx,
      args: ["@mxlang/language-server", "--stdio"],
    };
  }

  throw new Error(
    "could not find mxlang-language-server (local install, global install, bunx, or npx)",
  );
}
