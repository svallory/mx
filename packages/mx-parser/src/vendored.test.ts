import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseNpm } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { parse as parseVendored } from "./babel/index.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturesDir = `${repoRoot}/fixtures`;

const parserOptions: {
  sourceType: "module";
  plugins: ("jsx" | "typescript")[];
  tokens: false;
  ranges: false;
} = {
  sourceType: "module",
  plugins: ["jsx", "typescript"],
  tokens: false,
  ranges: false,
};

function fixtureTwins(): { name: string; source: string }[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = `${fixturesDir}/${entry.name}/twin.tsx`;
      return { name: entry.name, source: readFileSync(path, "utf8") };
    });
}

const syntheticSnippets: { name: string; source: string }[] = [
  {
    name: "generic-arrow",
    source: "const identity = <T,>(x: T) => x;\n",
  },
  {
    name: "class-with-decorators-disabled",
    source: "class Foo {\n  bar() {\n    return 1;\n  }\n}\n",
  },
  {
    name: "jsx-fragments-and-namespaced-attributes",
    source: `
      const el = (
        <>
          <div on:scroll={() => {}} prop:value="x" attr:title="y" bool:open={true}>
            <span>text</span>
          </div>
        </>
      );
    `,
  },
];

describe("vendored @babel/parser equivalence", () => {
  const cases = [...fixtureTwins(), ...syntheticSnippets];

  for (const { name, source } of cases) {
    it(`produces an identical AST to node_modules/@babel/parser for ${name}`, () => {
      const vendoredAst = parseVendored(source, parserOptions);
      const npmAst = parseNpm(source, parserOptions);

      expect(vendoredAst).toEqual(npmAst);
    });
  }
});
