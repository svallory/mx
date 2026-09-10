import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mxPlugin from "./bun.ts";

/**
 * Runs under `bun test`, not vitest: it exercises `Bun.plugin` and Bun's
 * dynamic `import()` of a `.mx` module, both Bun-runtime-only.
 */
describe("@markox/html/bun", () => {
  test("Bun.plugin registers an onLoad for .mx that compile()s and runs", async () => {
    Bun.plugin(mxPlugin);

    const fixtureDir = join(
      import.meta.dirname,
      "..",
      "fixtures-mx",
      "attributes",
    );
    const input = JSON.parse(
      readFileSync(join(fixtureDir, "input.json"), "utf8"),
    );
    const expected = readFileSync(join(fixtureDir, "expected.html"), "utf8");

    const mod = await import(join(fixtureDir, "input.mx"));
    const render = mod.default as (input: unknown) => string;

    expect(render(input)).toBe(expected);
  });
});
