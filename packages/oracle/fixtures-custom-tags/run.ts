/**
 * The six-host check for Custom Tags (decision 85, experiment
 * `custom-tags-check`).
 *
 * Compiles `icon/input.mx` through every host, renders it wherever a renderer
 * exists, and compares the rendered HTML for semantic equality the way the
 * oracles do (`parse5`, decoded tag/attribute/text content). The claim under
 * test: **one custom tag implementation, six hosts, no host-specific code in
 * the tag.**
 *
 * Run with `bun packages/oracle/fixtures-custom-tags/run.ts`. It is a throwaway
 * experiment harness, not a gate: the real feature's fixture set belongs under
 * `packages/core/src/fixtures/` with a per-host `expected.<host>.html` and a
 * count assertion, as `oracle:marko` has (decision 55).
 *
 * The custom tag map is built by hand here, from the one `.tag.ts` module this
 * fixture imports. A real implementation reads the template's `import`
 * statements and resolves each `*.tag.ts` specifier through the integration's
 * own resolver — see `@mxlang/core`'s `custom-tags.ts`.
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomTagDefinition } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { compile as compileHtml } from "@mxlang/html";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";
import { htmlEquals, normalizeHtml } from "../src/normalize-html.ts";
import icon from "./icon/icon.tag.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "icon");
const source = readFileSync(join(fixture, "input.mx"), "utf8");
const input = JSON.parse(readFileSync(join(fixture, "input.json"), "utf8"));

/** What the integration would have resolved from the template's imports. */
const customTags: Record<string, CustomTagDefinition> = { icon };

interface Row {
  host: string;
  status: "pass" | "fail" | "compile-error";
  detail?: string;
  html?: string;
}

/**
 * Loads an emitted module from a scratch directory linked to this repo's
 * `node_modules`.
 *
 * Same shape and the same reason as the oracle's own renderers: the emitted
 * module imports bare specifiers (`preact`, `react/jsx-runtime`,
 * `@mxlang/html`), and bare resolution walks up from the *importing file*,
 * which under the OS tmpdir finds no `node_modules` at all.
 */
async function loadModule(
  code: string,
  extension: "ts" | "tsx",
  jsxImportSource?: string,
): Promise<{ default: (input: unknown) => unknown }> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-customtags-"));
  // This package's own `node_modules`, not the workspace root's: `react`,
  // `react-dom` and `hono` are devDependencies of `@mxlang/oracle` and live
  // only here, while the root has the hoisted `.bun` store whose layout bare
  // resolution cannot walk into.
  const repoNodeModules = join(here, "..", "node_modules");
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "mx-customtags-scratch", type: "module" }),
  );
  if (jsxImportSource) {
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource },
      }),
    );
  }
  symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
  const entry = join(scratch, `mod.${extension}`);
  // The one bare workspace specifier each host's own output may carry, made
  // absolute for exactly the reason above.
  const rewritten = code
    .replace(
      'from "@mxlang/html"',
      `from ${JSON.stringify(require.resolve("@mxlang/html"))}`,
    )
    .replace(
      '"@mxlang/preact/runtime"',
      JSON.stringify(require.resolve("@mxlang/preact/runtime")),
    );
  writeFileSync(entry, rewritten);
  try {
    return (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => unknown;
    };
  } finally {
    // Left in place until the import settles; removed on the next run's
    // tmpdir churn rather than raced against the module registry.
    void scratch;
  }
}

async function runHtml(): Promise<Row> {
  const { code } = compileHtml(source, join(fixture, "input.mx"), {
    customTags,
  });
  const mod = await loadModule(code, "ts");
  return { host: "html", status: "pass", html: String(mod.default(input)) };
}

async function runPreact(): Promise<Row> {
  const { code } = compilePreactMx(source, join(fixture, "input.mx"), {
    customTags,
  });
  const mod = await loadModule(code, "tsx", "preact");
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const { h } = (await import("preact")) as {
    h: (type: unknown, props: unknown) => unknown;
  };
  return {
    host: "preact",
    status: "pass",
    html: render(h(mod.default, input)),
  };
}

async function runReact(): Promise<Row> {
  const { code } = compileReactMx(source, join(fixture, "input.mx"), {
    customTags,
  });
  const mod = await loadModule(code, "tsx", "react");
  const { createElement } = (await import("react")) as {
    createElement: (type: unknown, props: unknown) => unknown;
  };
  const { renderToStaticMarkup } = (await import("react-dom/server")) as {
    renderToStaticMarkup: (node: unknown) => string;
  };
  return {
    host: "react",
    status: "pass",
    html: renderToStaticMarkup(
      createElement(mod.default as never, input as never),
    ),
  };
}

async function runHono(): Promise<Row> {
  const { code } = compileHonoMx(source, join(fixture, "input.mx"), {
    customTags,
  });
  const mod = await loadModule(code, "tsx", "hono/jsx");
  const { jsx } = (await import("hono/jsx")) as {
    jsx: (
      type: unknown,
      props: Record<string, unknown>,
    ) => { toString(): string | Promise<string> };
  };
  const rendered = jsx(mod.default, input as Record<string, unknown>);
  return {
    host: "hono",
    status: "pass",
    html: String(await rendered.toString()),
  };
}

/**
 * Solid: compiled, not rendered to HTML.
 *
 * `.solid.mx` is MX regions inside a TypeScript module, so there is no
 * whole-file `.mx` path on this host; the region is compiled through
 * `compileSolidMx` and the *emitted Solid JSX* is checked for the same `<svg>`
 * subtree the other hosts render. Rendering it would mean standing up
 * `dom-expressions` and a DOM, which the oracle already does for its own
 * fixtures and which proves nothing further about the tag.
 */
function runSolid(): Row {
  const region = readFileSync(join(fixture, "input.mx"), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("import icon"))
    .join("\n");
  const { code } = compileSolidMx(region, {
    filename: join(fixture, "input.solid.mx"),
    customTags,
  });
  return { host: "solid", status: "pass", html: code };
}

/**
 * Astro: the `.mx` component path, which is `@mxlang/html`'s own compile.
 *
 * A `.mx` component inside an Astro project is rendered by
 * `@mxlang/astro`'s renderer, which calls the module `@mxlang/html`
 * compiled — under `strictPolicy`, this host's one difference. So the check
 * here is that same compile with `strict: true`, rendered the same way.
 */
async function runAstro(): Promise<Row> {
  const { code } = compileHtml(source, join(fixture, "input.mx"), {
    customTags,
    strict: true,
  });
  const mod = await loadModule(code, "ts");
  return { host: "astro", status: "pass", html: String(mod.default(input)) };
}

async function attempt(
  host: string,
  run: () => Row | Promise<Row>,
): Promise<Row> {
  try {
    return await run();
  } catch (error) {
    return {
      host,
      status: "compile-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const rows: Row[] = [
  await attempt("html", runHtml),
  await attempt("astro", runAstro),
  await attempt("preact", runPreact),
  await attempt("react", runReact),
  await attempt("hono", runHono),
  await attempt("solid", runSolid),
];

// The comparison baseline: the `html` host's own render, normalized. Attribute
// order is ignored, as `oracle:preact` does — Preact, React and Hono each own
// their serializer and emit props in their own order.
const baseline = rows.find((row) => row.host === "html")?.html;

console.log("\ncustom-tags-check: `<icon>` on six hosts\n");
for (const row of rows) {
  if (row.status === "compile-error") {
    console.log(`  ${row.host.padEnd(8)} COMPILE ERROR  ${row.detail}`);
    continue;
  }
  if (row.host === "solid") {
    // Emitted JSX, not HTML: assert the `<svg>` subtree three times over.
    const count = (row.html?.match(/<svg/g) ?? []).length;
    const ok = count === 3 && /viewBox="0 0 24 24"/.test(row.html ?? "");
    console.log(
      `  ${row.host.padEnd(8)} ${ok ? "pass" : "FAIL"}  (emitted JSX: ${count} <svg>)`,
    );
    if (process.env.MX_SHOW_HTML) console.log(row.html);
    continue;
  }
  const ok =
    baseline !== undefined &&
    htmlEquals(row.html ?? "", baseline, { attributeOrder: "ignore" });
  console.log(`  ${row.host.padEnd(8)} ${ok ? "pass" : "FAIL"}`);
  if (process.env.MX_SHOW_HTML) {
    console.log(`      ${normalizeHtml(row.html ?? "")}`);
  }
  if (!ok) {
    console.log(`      got: ${normalizeHtml(row.html ?? "")}`);
    console.log(`      want: ${normalizeHtml(baseline ?? "")}`);
  }
}

console.log(
  `\nbaseline (html host, normalized):\n${normalizeHtml(baseline ?? "")}\n`,
);
