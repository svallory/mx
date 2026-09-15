import {
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
import type { CustomTag } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { compile as compileHtml } from "@mxlang/html";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";
import { transform as nativeTransform } from "@solidjs/compiler";
import { normalizeHtml } from "../src/normalize-html.ts";
import icon from "./icon/icon.tag.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "icon");
const source = readFileSync(join(fixture, "input.mx"), "utf8");
const input = JSON.parse(readFileSync(join(fixture, "input.json"), "utf8"));
const expected = readFileSync(join(fixture, "expected.html"), "utf8");
const customTags: Record<string, CustomTag> = { icon };

export interface CustomTagFixtureRow {
  host: "html" | "astro" | "preact" | "react" | "hono" | "solid";
  status: "pass" | "fail";
  detail?: string;
}

const EXPECTED_HOSTS = 6;

async function loadModule(
  code: string,
  extension: "ts" | "tsx" | "jsx",
  jsxImportSource?: string,
): Promise<{ default: (input: unknown) => unknown }> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-custom-tags-"));
  try {
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ name: "mx-custom-tags-scratch", type: "module" }),
    );
    if (jsxImportSource) {
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource },
        }),
      );
    }
    symlinkSync(
      join(here, "..", "node_modules"),
      join(scratch, "node_modules"),
      "dir",
    );
    const entry = join(scratch, `mod.${extension}`);
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
    return (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => unknown;
    };
  } finally {
    // Bun completes the module load before the import promise settles.
    rmSync(scratch, { recursive: true, force: true });
  }
}

function compared(
  host: CustomTagFixtureRow["host"],
  html: string,
): CustomTagFixtureRow {
  return html.trimEnd() === expected.trimEnd()
    ? { host, status: "pass" }
    : {
        host,
        status: "fail",
        detail: `got ${normalizeHtml(html)}; want ${normalizeHtml(expected)}`,
      };
}

async function runHtml(strict: boolean): Promise<string> {
  const { code } = compileHtml(source, join(fixture, "input.mx"), {
    customTags,
    strict,
  });
  const mod = await loadModule(code, "ts");
  return String(mod.default(input));
}

async function runPreact(): Promise<string> {
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
  return render(h(mod.default, input));
}

async function runReact(): Promise<string> {
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
  return renderToStaticMarkup(
    createElement(mod.default as never, input as never),
  );
}

async function runHono(): Promise<string> {
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
  return String(
    await jsx(mod.default, input as Record<string, unknown>).toString(),
  );
}

/**
 * Renders the fixture through Solid, so this row compares real output like
 * every other host rather than counting tags in the emitted source.
 *
 * MX lowers to Solid JSX text, which is a list of roots rather than a module,
 * so it is wrapped in a component before `@solidjs/compiler` sees it — the
 * same `generate: "ssr"` path `src/compile.ts` uses, with `hydratable: false`
 * so Solid emits no hydration markers and the bytes can be compared directly
 * against `expected.html`.
 */
async function runSolid(): Promise<string> {
  const { code } = compileSolidMx(source, {
    filename: join(fixture, "input.solid.mx"),
    customTags,
  });
  const wrapped = `import { For, Show } from "solid-js";
export default function Fixture(input) { return <>${code}</>; }`;
  const compiled = nativeTransform(wrapped, {
    filename: join(fixture, "fixture.tsx"),
    generate: "ssr",
    hydratable: false,
  });
  if (!compiled?.code) {
    throw new Error(
      "@solidjs/compiler produced no output for the icon fixture",
    );
  }

  // Solid's runtime is hoisted to the workspace root, which the scratch
  // directory's symlinked `node_modules` does not reach; resolve both from
  // here, exactly as the other hosts' imports are resolved.
  const mod = await loadModule(
    compiled.code
      .replaceAll(
        'from "@solidjs/web"',
        `from ${JSON.stringify(require.resolve("@solidjs/web"))}`,
      )
      .replaceAll(
        'from "solid-js"',
        `from ${JSON.stringify(require.resolve("solid-js"))}`,
      ),
    "jsx",
  );
  const { renderToString } = (await import("@solidjs/web")) as {
    renderToString: (fn: () => unknown) => string;
  };
  return renderToString(() => mod.default(input));
}

async function attempt(
  host: CustomTagFixtureRow["host"],
  run: () => string | Promise<string>,
): Promise<CustomTagFixtureRow> {
  try {
    return compared(host, await run());
  } catch (error) {
    return {
      host,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runCustomTagFixtures(): Promise<CustomTagFixtureRow[]> {
  const rows = [
    await attempt("html", () => runHtml(false)),
    await attempt("astro", () => runHtml(true)),
    await attempt("preact", runPreact),
    await attempt("react", runReact),
    await attempt("hono", runHono),
    await attempt("solid", runSolid),
  ];

  if (rows.length !== EXPECTED_HOSTS) {
    throw new Error(
      `custom-tag count gate: ran ${rows.length} hosts, expected ${EXPECTED_HOSTS}`,
    );
  }
  return rows;
}

if (import.meta.main) {
  const rows = await runCustomTagFixtures();
  console.log("custom-tags: icon fixture");
  for (const row of rows) {
    console.log(
      `${row.host.padEnd(8)} ${row.status}${row.detail ? ` — ${row.detail}` : ""}`,
    );
  }
  const passed = rows.filter((row) => row.status === "pass").length;
  console.log(`${passed}/${EXPECTED_HOSTS} hosts passed`);
  if (passed !== EXPECTED_HOSTS) process.exitCode = 1;
}
