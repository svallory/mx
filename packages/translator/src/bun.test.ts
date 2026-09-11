import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import markoPlugin from "./bun.ts";

/**
 * Runs under `bun test`, not vitest: it exercises `Bun.plugin` and Bun's
 * dynamic `import()` of a `.marko` module, both Bun-runtime-only.
 */
describe("@markox/translator/bun", () => {
  test("Bun.plugin registers an onLoad for .marko that compile()s and runs", async () => {
    Bun.plugin(markoPlugin);

    const fixtureDir = join(
      import.meta.dirname,
      "..",
      "fixtures-marko",
      "attributes",
    );
    const input = JSON.parse(
      readFileSync(join(fixtureDir, "input.json"), "utf8"),
    ) as { value: string };

    const mod = await import(join(fixtureDir, "input.marko"));
    const render = mod.default as (input: unknown) => string;

    // Exact HTML parity with real Marko is `oracle:marko`'s job (semantic
    // comparison, quote-style-insensitive) — this test only exercises the
    // loader wiring: the plugin claims `.marko`, compiles it, and the
    // dynamically imported module runs and renders the given input.
    expect(render(input)).toContain(input.value);
  });

  test("Bun.plugin also claims .mx, the official extension (decision 72)", async () => {
    Bun.plugin(markoPlugin);

    const fixtureDir = join(
      import.meta.dirname,
      "..",
      "fixtures-marko",
      "attributes",
    );
    const input = JSON.parse(
      readFileSync(join(fixtureDir, "input.json"), "utf8"),
    ) as { value: string };
    const source = readFileSync(join(fixtureDir, "input.marko"), "utf8");

    // Written alongside input.marko, not a bare tmpdir: the emitted module
    // imports `escape` from "@markox/translator" by bare specifier, which
    // Bun resolves via node_modules lookup from the file's own directory —
    // a tmpdir outside the package tree can't resolve it.
    const path = join(fixtureDir, "input.mx");
    writeFileSync(path, source);
    try {
      const mod = await import(path);
      const render = mod.default as (input: unknown) => string;
      expect(render(input)).toContain(input.value);
    } finally {
      rmSync(path);
    }
  });

  test("does not claim a .solid.mx path", async () => {
    Bun.plugin(markoPlugin);

    // Real SolidMX source: it would fail the string translator outright
    // (JSX like <button onClick={...}> isn't valid `.marko` syntax), so the
    // regression this guards against is real, not just theoretical.
    const dir = mkdtempSync(join(tmpdir(), "markox-translator-bun-solid-"));
    const path = join(dir, "Counter.solid.mx");
    writeFileSync(
      path,
      `export function Counter() {
  return <button onClick={() => {}}>Count</button>;
}
`,
    );

    // Bun's default loader for an unrecognized extension returns the file's
    // own path as the module's default export, not a compiled function -
    // exactly what "the onLoad hook declined this path" looks like from the
    // caller's side.
    const mod = await import(path);
    expect(mod.default).toEndWith("Counter.solid.mx");
  });
});
