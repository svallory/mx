import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("does not claim a .solid.mx path, even though .mx$ matches it too", async () => {
    Bun.plugin(mxPlugin);

    // Real SolidMX source: it would fail the string-HTML translator outright
    // (JSX like <button onClick={...}> isn't valid `.mx` syntax), so the
    // regression this guards against is real, not just theoretical.
    const dir = mkdtempSync(join(tmpdir(), "mx-html-bun-solid-"));
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
