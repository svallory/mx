import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compare } from "./compare";
import { compileFile, VARIANTS } from "./compile";
import { discoverFixtures } from "./fixtures";
import { normalize } from "./normalize";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "..", "..", "fixtures");
const divergencesPath = join(fixturesRoot, "divergences.md");
const fixtures = discoverFixtures(fixturesRoot);

describe("compile: .tsx pipeline", () => {
  const counterTwin = join(fixturesRoot, "counter", "twin.tsx");
  const domVariant = VARIANTS.find((v) => v.generate === "dom");
  if (!domVariant) throw new Error("expected a dom variant in VARIANTS");

  it("compiling twin.tsx twice yields identical output", () => {
    const first = compileFile(counterTwin, domVariant);
    const second = compileFile(counterTwin, domVariant);
    expect(first).toBe(second);
  });

  it("extra whitespace matches after normalize", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-oracle-"));
    try {
      const reformatted = join(dir, "reformatted.tsx");
      const source = readFileSync(counterTwin, "utf8");
      const spaced = source.replace(/ /g, "   ").replace(/\n/g, "\n\n");
      writeFileSync(reformatted, spaced);

      const original = normalize(compileFile(counterTwin, domVariant));
      const reformattedOutput = normalize(compileFile(reformatted, domVariant));
      expect(reformattedOutput).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compare: fixtures without mxParser are skipped", () => {
  for (const fixture of fixtures) {
    it(`${fixture}: all variants report skipped`, () => {
      const results = compare(join(fixturesRoot, fixture), { divergencesPath });
      expect(results.length).toBe(VARIANTS.length);
      for (const r of results) {
        expect(r.status).toBe("skipped");
      }
    });
  }
});

describe("compare: golden snapshots", () => {
  for (const fixture of fixtures) {
    it(`${fixture}: golden files exist after compare`, () => {
      const goldenDir = join(fixturesRoot, fixture, "__golden__");
      compare(join(fixturesRoot, fixture), { divergencesPath });
      for (const variant of VARIANTS) {
        const key = `${variant.generate}${variant.hydratable ? "-hydratable" : ""}`;
        expect(existsSync(join(goldenDir, `twin.${key}.js`))).toBe(true);
      }
    });
  }
});

describe("normalize", () => {
  it("preserves whitespace inside string literals", () => {
    const code = `const s = "a   b";`;
    expect(normalize(code)).toBe(`const s = "a   b";`);
  });

  it("preserves template literal contents", () => {
    const code = "const s = `a   b\n  c`;";
    expect(normalize(code)).toBe("const s = `a   b\n  c`;");
  });

  it("collapses whitespace runs outside literals", () => {
    const code = "const   x   =   1;";
    expect(normalize(code)).toBe("const x = 1;");
  });

  it("converts CRLF to LF", () => {
    const code = "const x = 1;\r\nconst y = 2;\r\n";
    expect(normalize(code)).toBe("const x = 1;\nconst y = 2;\n");
  });

  it("trims trailing spaces", () => {
    const code = "const x = 1;   \nconst y = 2;\t\n";
    expect(normalize(code)).toBe("const x = 1;\nconst y = 2;\n");
  });
});
