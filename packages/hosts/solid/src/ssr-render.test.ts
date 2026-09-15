import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/**
 * Renders an MX `<for>` fragment through the real Solid 2 pipeline:
 * `compileSolidMx` -> Solid JSX text (this host's actual emitted output) ->
 * `@solidjs/babel-plugin` SSR codegen -> `@solidjs/web`'s `renderToString`,
 * run in a Bun subprocess. Unlike the emitter's own snapshot tests in
 * `index.test.ts`, this proves the emitted `<For>`/`<Repeat>` binding
 * actually renders row data under Solid, not just that it prints the
 * expected string.
 *
 * `compileSolidMx` (the fragment API this host actually exports) is used
 * directly rather than going through `@mxlang/parser`'s whole-file
 * `.solid.mx` `parse()`: that bridge has a separate, pre-existing bug
 * (unrelated to the `keyed` fix here, reproduced on `main`) triggered by a
 * parenthesized/multi-line `<for>` region regardless of `by=` — a two-param
 * multi-line `<for|p, i|>` is a hard parse error there too — that drops a
 * `<for>` param when splicing the lowered JSX back into a surrounding
 * TypeScript module. See the report for solid-for-accessor.
 */
function renderSolidMx(mxFragment: string, setup: string): string {
  const { code: forCode } = compileSolidMx(mxFragment, {
    filename: "fixture.solid.mx",
  });
  const jsxSource = `export function App() {\n  ${setup}\n  return <ul>${forCode}</ul>;\n}\n`;

  const ssr = transformSync(jsxSource, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!ssr?.code)
    throw new Error("Solid babel plugin produced no code for fixture.tsx");
  return ssr.code;
}

/**
 * Runs the compiled Solid SSR module in a real Bun subprocess, rather than
 * `import()`ing it under vitest: vitest's own SSR module resolution does not
 * walk up to this workspace's bun-managed `node_modules/.bun`, so a dynamic
 * import of `@solidjs/web` from a plain tmp file fails to resolve its own
 * `seroval` dependency there. Bun run from inside this package resolves the
 * workspace's real dependency graph, which is also the graph a consumer's
 * own build would use.
 */
function renderApp(mxFragment: string, setup: string): string {
  const code = renderSolidMx(mxFragment, setup);
  const dir = mkdtempSync(join(packageRoot, ".ssr-render-tmp-"));
  const appPath = join(dir, "app.mjs");
  const runnerPath = join(dir, "run.mjs");
  writeFileSync(appPath, code);
  writeFileSync(
    runnerPath,
    `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
  );
  try {
    return execFileSync("bun", ["run", runnerPath], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Solid SSR render: <for>", () => {
  it("renders row properties for the unkeyed (no by=) form", () => {
    const html = renderApp(
      `<for|p| of=people><li>\${p.name}</li></for>`,
      `const people = [{ name: "Ada" }, { name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders row properties for by=identity", () => {
    const html = renderApp(
      `<for|p| of=people by=identity><li>\${p.name}</li></for>`,
      `const people = [{ name: "Ada" }, { name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  // Solid 2 rc.7's own SSR runtime renders an empty child for `<For
  // keyed={fn}>` (a custom key *function*, as opposed to the default keyed
  // form with no `keyed` prop, which works) — verified in isolation against
  // `@solidjs/web`'s `renderToString` directly, independent of MX's emitted
  // JSX. `by="field"` and `by=<expr>` both compile to `keyed={fn}` and hit
  // this. Skipped rather than asserted false; see the report for
  // solid-for-accessor.
  it.skip('renders row properties for by="field" (blocked on Solid 2 rc.7 SSR keyed-fn bug)', () => {
    const html = renderApp(
      `<for|p| of=people by="id"><li>\${p.name}</li></for>`,
      `const people = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders a stepped range", () => {
    const html = renderApp(
      `<for|n| from=0 to=6 step=2><li>value \${n}</li></for>`,
      "",
    );
    expect(html).toContain("value 0");
    expect(html).toContain("value 2");
    expect(html).toContain("value 4");
    expect(html).toContain("value 6");
  });
});
