import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
);

describe("Manifest", () => {
  it("has correct engines", () => {
    expect(pkg.engines.vscode).toBeDefined();
  });

  it("has languages", () => {
    expect(pkg.contributes.languages.length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    const mx = pkg.contributes.languages.find((l: any) => l.id === "mx");
    expect(mx.extensions).toContain(".mx");
    expect(mx.extensions).toContain(".marko");
  });

  it("references existing configuration", () => {
    for (const lang of pkg.contributes.languages) {
      if (lang.configuration) {
        const configPath = path.join(__dirname, "..", lang.configuration);
        expect(fs.existsSync(configPath)).toBe(true);
      }
    }
  });

  it("references existing grammars", () => {
    for (const grammar of pkg.contributes.grammars) {
      if (grammar.path) {
        const grammarPath = path.join(__dirname, "..", grammar.path);
        expect(fs.existsSync(grammarPath)).toBe(true);
      }
    }
  });

  it("contributes typescript plugin", () => {
    const tsPlugin = pkg.contributes.typescriptServerPlugins[0];
    expect(tsPlugin.name).toBe("@mxlang/typescript-plugin");
    expect(tsPlugin.languages).toContain("mx");
    expect(tsPlugin.languages).toContain("solidmx");
    expect(tsPlugin.languages).toContain("astromx");
  });
});
