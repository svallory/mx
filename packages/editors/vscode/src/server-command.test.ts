import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerCommand } from "./server-command.js";

vi.mock("fs");
vi.mock("child_process");

describe("getServerCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses configured path if provided", () => {
    const cmd = getServerCommand("/custom/path/bin", []);
    expect(cmd.command).toBe("/custom/path/bin");
  });

  it("uses local install if marker exists", () => {
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      return p.includes(
        path.join("@mxlang", "language-server", "package.json"),
      );
    });
    const cmd = getServerCommand(undefined, ["/workspace"]);
    const expectedBinName =
      process.platform === "win32"
        ? "mxlang-language-server.cmd"
        : "mxlang-language-server";
    expect(cmd.command).toBe(
      path.join("/workspace", "node_modules", ".bin", expectedBinName),
    );
  });

  it("uses global install if found", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("mxlang-language-server"))
        return "/global/mxlang-language-server";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect(cmd.command).toBe("/global/mxlang-language-server");
  });

  it("falls back to bunx", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("bunx")) return "/usr/local/bin/bunx";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect(cmd.command).toBe("/usr/local/bin/bunx");
    expect(cmd.args).toEqual(["@mxlang/language-server", "--stdio"]);
  });

  it("falls back to npx", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("npx")) return "/usr/local/bin/npx";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect(cmd.command).toBe("/usr/local/bin/npx");
    expect(cmd.args).toEqual(["@mxlang/language-server", "--stdio"]);
  });

  it("throws if resolution fails entirely", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((_cmd: any) => {
      throw new Error();
    });

    expect(() => getServerCommand(undefined, [])).toThrow(
      "could not find mxlang-language-server",
    );
  });
});
