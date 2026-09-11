import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import mx, { MX_SUFFIX } from "./index";

const COUNTER = `import { createSignal } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <button onClick() { setCount(count() + 1) }>Count: \${count()}</button>
  );
}
`;

const BROKEN = `export function A() {
  return (
    <div><span>oops</div>
  );
}
`;

interface TransformResult {
  code: string;
  map: unknown;
}

/**
 * A stand-in for Vite's plugin context. `resolve` mimics the real resolver
 * closely enough for the hook's own logic to be exercised: relative ids are
 * joined against the importer's directory, root-relative ids against `root`,
 * and `alias` entries are applied by prefix. Anything unknown resolves to
 * null, the way a bare specifier with no match would.
 */
function makeContext(
  opts: {
    root?: string;
    alias?: Record<string, string>;
    resolvable?: (id: string) => boolean;
  } = {},
) {
  const calls: Array<{ id: string; importer?: string; skipSelf?: boolean }> =
    [];
  const context = {
    calls,
    async resolve(
      id: string,
      importer?: string,
      options?: { skipSelf?: boolean },
    ) {
      calls.push({ id, importer, skipSelf: options?.skipSelf });

      const queryIndex = id.search(/[?#]/);
      const path = queryIndex === -1 ? id : id.slice(0, queryIndex);
      const suffix = queryIndex === -1 ? "" : id.slice(queryIndex);

      let resolved: string | null = null;
      for (const [from, to] of Object.entries(opts.alias ?? {})) {
        if (path.startsWith(from)) {
          resolved = to + path.slice(from.length);
          break;
        }
      }
      if (resolved === null) {
        if (path.startsWith("/") && opts.root) {
          resolved = join(opts.root, path);
        } else if (path.startsWith(".")) {
          if (!importer) return null;
          resolved = resolvePath(dirname(importer), path);
        } else if (opts.resolvable?.(path)) {
          resolved = path;
        } else {
          return null;
        }
      }

      return { id: resolved + suffix };
    },
  };
  return context;
}

type Hooks = ReturnType<typeof mx>;

function resolveIdOf(plugin: Hooks) {
  const { resolveId } = plugin;
  if (typeof resolveId !== "function") throw new Error("no resolveId hook");
  return resolveId as unknown as (
    this: unknown,
    id: string,
    importer?: string,
  ) => Promise<string | null>;
}

function loadOf(plugin: Hooks) {
  const { load } = plugin;
  if (typeof load !== "function") throw new Error("no load hook");
  return load as unknown as (this: unknown, id: string) => string | null;
}

function transformOf(plugin: Hooks) {
  const { transform } = plugin;
  if (typeof transform !== "function") throw new Error("no transform hook");
  return transform as unknown as (
    this: unknown,
    code: string,
    id: string,
  ) => Promise<TransformResult | null>;
}

/** Writes `source` to a real temp file, since `load` reads from disk. */
function writeMx(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-plugin-"));
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe("mx()", () => {
  it("is a pre-enforced plugin named mx", () => {
    const plugin = mx();
    expect(plugin.name).toBe("mx");
    expect(plugin.enforce).toBe("pre");
  });

  describe("resolveId", () => {
    it("resolves a relative import from a nested importer", async () => {
      // The importer is a .tsx two directories deep; the old local path math
      // sliced the suffix length off the *importer* and landed a directory up.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "./Counter.solid.mx",
        "/root/src/features/index.tsx",
      );

      expect(resolved).toBe(`/root/src/features/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("delegates with skipSelf so the hook cannot recurse", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      await resolveId.call(context, "./A.solid.mx", "/root/src/index.tsx");

      expect(context.calls).toHaveLength(1);
      expect(context.calls[0]?.skipSelf).toBe(true);
    });

    it("resolves a root-relative id against the project root", async () => {
      const context = makeContext({ root: "/root" });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "/src/Counter.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("resolves an aliased id", async () => {
      const context = makeContext({ alias: { "@/": "/root/src/" } });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "@/Counter.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("resolves a bare specifier into a workspace package", async () => {
      const context = makeContext({
        resolvable: (id) => id === "@acme/ui/Card.solid.mx",
      });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "@acme/ui/Card.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`@acme/ui/Card.solid.mx${MX_SUFFIX}`);
    });

    it("keeps the query string on the rewritten id", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      // Vite appends `?t=` on an HMR re-fetch; dropping it would serve a
      // stale module.
      const resolved = await resolveId.call(
        context,
        "./A.solid.mx?t=1712345",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/A.solid.mx${MX_SUFFIX}?t=1712345`);
    });

    it("declines ?raw, ?url and worker queries", async () => {
      // These ask for the file itself, not the module MX would print, so Vite
      // must serve the real `.solid.mx` rather than a virtual `.tsx` path that
      // does not exist on disk.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const importer = "/root/src/index.tsx";

      for (const query of ["?raw", "?url", "?worker", "?sharedworker"]) {
        expect(
          await resolveId.call(context, `./A.solid.mx${query}`, importer),
        ).toBeNull();
      }
      expect(context.calls).toHaveLength(0);
    });

    it("returns an already-rewritten id unchanged, query included", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const id = `/root/src/A.solid.mx${MX_SUFFIX}?t=1`;

      expect(await resolveId.call(context, id, undefined)).toBe(id);
      // No delegation needed for an id we already own.
      expect(context.calls).toHaveLength(0);
    });

    it("returns null when the resolver finds nothing", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      expect(
        await resolveId.call(context, "./missing.solid.mx", undefined),
      ).toBeNull();
    });

    it("leaves AstroMX's .amx alone: a different host's extension", async () => {
      // `.amx` (decision 78) belongs to `@mxlang/astro`'s own plugin, which
      // lowers it to Astro template syntax. Its last extension segment differs
      // from `.mx`, so the plain `endsWith` match never claims it — this pins
      // that, since the two plugins run in the same Vite instance.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      expect(
        await resolveId.call(context, "./Base.amx", "/root/src/index.tsx"),
      ).toBeNull();
      expect(context.calls).toHaveLength(0);
    });

    it("declines a multi-dot extension owned by another host", async () => {
      // The foreign-extension guard is empty today, but the collision it
      // defends against is a property of the `endsWith` matching rule rather
      // than of any one extension: a registered `.mx` matches `Base.any.mx`
      // just as readily as `Base.mx`. Registering the longer extension is what
      // makes the longest-first sort pick it, which is the same mechanism that
      // keeps `.solid.mx` from being compiled as `.mx`.
      const context = makeContext();
      const resolveId = resolveIdOf(mx({ extensions: [".other.mx", ".mx"] }));

      expect(
        await resolveId.call(context, "./Base.other.mx", "/root/src/index.tsx"),
      ).toBe("/root/src/Base.other.mx.tsx");
    });

    it("leaves ids it does not handle alone", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const importer = "/root/src/index.tsx";

      expect(await resolveId.call(context, "./main.tsx", importer)).toBeNull();
      expect(await resolveId.call(context, "solid-js", importer)).toBeNull();
      expect(context.calls).toHaveLength(0);
    });
  });

  describe("load", () => {
    it("reads the real .solid.mx file behind the suffixed id", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const load = loadOf(mx());

      expect(load.call({}, path + MX_SUFFIX)).toBe(COUNTER);
      expect(load.call({}, "/app/src/main.tsx")).toBeNull();
    });

    it("does not shadow a real .solid.mx.tsx file on disk", () => {
      // Foo.solid.mx.tsx exists but Foo.solid.mx does not: the id belongs to
      // the real file, so the hook must decline and let Vite read it.
      const real = writeMx(
        `Shadow.solid.mx${MX_SUFFIX}`,
        "export const a = 1;",
      );
      const load = loadOf(mx());

      expect(load.call({}, real)).toBeNull();
    });
  });

  describe("transform", () => {
    it("prints a .solid.mx module to JSX text plus a map", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
      expect(result?.code).toContain("onClick={");
      // The MX placeholder must have become a JSX expression child.
      expect(result?.code).toContain("{count()}");
      expect(result?.code).not.toContain(`\${count()}`);
      expect(result?.map).toMatchObject({ version: 3 });
    });

    it("names the .solid.mx file, not the .tsx id, in the source map", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);
      const map = result?.map as { sources: string[] };

      expect(map.sources).toContain(path);
    });

    it("strips a query string before matching the id", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call(
        {},
        COUNTER,
        `${path}${MX_SUFFIX}?t=1712345`,
      );

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
    });

    it("returns null for ids it does not handle", async () => {
      const transform = transformOf(mx());
      const code = "export const a = 1;";

      expect(await transform.call({}, code, "/src/main.tsx")).toBeNull();
      expect(await transform.call({}, code, "/src/main.ts")).toBeNull();
      expect(await transform.call({}, "body {}", "/src/app.css")).toBeNull();
    });

    it("throws a Vite-shaped error with loc, a frame, and no (l:c) suffix", async () => {
      const path = writeMx("Broken.solid.mx", BROKEN);
      const transform = transformOf(mx());

      let caught: unknown;
      try {
        await transform.call({}, BROKEN, path + MX_SUFFIX);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        loc?: { file: string; line: number; column: number };
        frame?: string;
      };

      // The overlay must point at the .solid.mx source, not the internal id.
      expect(error.loc?.file).toBe(path);
      // The mismatched closing tag is on line 3 of BROKEN.
      expect(error.loc?.line).toBe(3);
      expect(typeof error.loc?.column).toBe("number");

      // Babel's own 1-based "(line:column)" must not survive alongside the
      // 0-based loc.column, or the reader sees two different columns.
      expect(error.message).not.toMatch(/\(\d+:\d+\)\s*$/);

      expect(error.frame).toContain("<div><span>oops</div>");
      expect(error.frame).toContain("^");
    });
  });

  describe("stock .marko (not .solid.mx)", () => {
    const GREETING = `export interface Input { name: string }
<h1>Hello, \${input.name}</h1>
`;

    it("resolves a .marko id to a .ts-suffixed module, not .tsx", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "./greeting.marko",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe("/root/src/greeting.marko.ts");
    });

    // The 20s timeout below: this is the only test in the file that reaches
    // the `.marko` branch, so it pays for the dynamic
    // `import("@mxlang/translator")` and, through it, the cold load of
    // `@marko/compiler` — measured at **1145ms idle**, and at **6117ms**
    // inside a full `bun run verify` (20 vitest projects in parallel, ~34s of
    // transform), which overruns vitest's 5000ms default.
    //
    // 20s is a little over 3x the worst measured time rather than 4x the idle
    // one: 4 x 1145ms is 4.6s, still under the default that already fails, so
    // it would fix nothing. Scoped to this test rather than raised globally,
    // so a genuinely hung test elsewhere still fails fast.
    it("compiles a .marko module to a string-returning function, unaffected by .solid.mx handling", async () => {
      const path = writeMx("greeting.marko", GREETING);
      const transform = transformOf(mx());

      const result = await transform.call({}, GREETING, `${path}.ts`);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("export default render;");
      expect(result?.code).toContain("escape(input.name)");
      // No real map yet for this path (see the plugin's own doc comment).
      expect(result?.map).toBeNull();
    }, 20_000);

    it("passes `strict` through to the translator's strictPolicy", async () => {
      // The seam `@mxlang/astro` needs: a host with no reactive target selects
      // `strictPolicy`, so a reactive construct is a compile error naming the
      // construct rather than markup that renders once and never updates. The
      // flag is a passthrough — no policy logic lives in this plugin.
      const STATEFUL = `export interface Input {}
<let/count=0/>
<p>\${count}</p>
`;
      const path = writeMx("stateful.marko", STATEFUL);
      const transform = transformOf(mx({ strict: true }));

      await expect(transform.call({}, STATEFUL, `${path}.ts`)).rejects.toThrow(
        /`<let>` is reactive state/,
      );
    });

    it("renders <let>'s initial value when `strict` is not set", async () => {
      // The default policy is unchanged by the option's existence: decision 65
      // renders what Marko's own server render emits.
      const STATEFUL = `export interface Input {}
<let/count=0/>
<p>\${count}</p>
`;
      const path = writeMx("stateful-default.marko", STATEFUL);
      const transform = transformOf(mx());

      const result = await transform.call({}, STATEFUL, `${path}.ts`);

      expect(result?.code).toContain("const count = 0;");
    });

    it("still handles .solid.mx exactly as before when both extensions are enabled", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);

      expect(result?.code).toContain("<button");
    });

    it.each([
      [".marko", ".solid.marko"],
      [".solid.marko", ".marko"],
    ])(
      "routes a longer extension correctly regardless of extensions order (given %j)",
      async (...order) => {
        // ".marko" is a genuine string suffix of the synthetic ".solid.marko"
        // here, and `suffixFor` only special-cases the literal strings
        // ".marko"/".mx" (-> .ts; everything else -> the JSX suffix), so
        // misrouting is directly observable in the resolved id's own suffix.
        //
        // Removing the `.sort(...)` at index.ts:177-179 makes the
        // `[".marko", ".solid.marko"]` order in this test fail: `matchExt`
        // would then return the caller's first array match, ".marko", for
        // "./Counter.solid.marko" (a string ending in ".solid.marko" also
        // ends in ".marko"), and `suffixFor(".marko")` is ".ts" — wrong for
        // a file that should route through the generic (".tsx") branch.
        // Verified directly: temporarily replacing the sorted `extensions`
        // assignment with the unsorted `[...(options.extensions ??
        // DEFAULT_EXTENSIONS)]` makes exactly the `[".marko",
        // ".solid.marko"]` case of this test fail on the suffix assertion
        // below (got `.../Counter.solid.marko.ts`, wanted `...tsx`), while
        // the `[".solid.marko", ".marko"]` case still passes — proving the
        // sort, not incidental array order, is what this test depends on.
        const plugin = mx({ extensions: order });

        const resolveId = resolveIdOf(plugin);
        const resolved = await resolveId.call(
          makeContext(),
          "./Counter.solid.marko",
          "/root/src/index.tsx",
        );
        // .tsx (the generic/JSX suffix), not .ts (the .marko-specific
        // suffix) — proves the longer ".solid.marko" extension won
        // regardless of extensions order.
        expect(resolved).toBe("/root/src/Counter.solid.marko.tsx");
      },
    );

    it.each([
      [".solid.mx", ".mx", ".marko"],
      [".mx", ".marko", ".solid.mx"],
      [".marko", ".solid.mx", ".mx"],
    ])(
      "routes .solid.mx correctly regardless of extensions order, with .mx in the mix (given %j)",
      async (...order) => {
        // ".mx" is a real string suffix of ".solid.mx" again (decision 72:
        // ".mx" is the official extension, restored alongside ".marko" as an
        // alias) — this is the live collision the longest-first sort at
        // index.ts:177-179 exists for, not a synthetic stand-in.
        const plugin = mx({ extensions: order });

        const resolveId = resolveIdOf(plugin);
        const resolvedSolidMx = await resolveId.call(
          makeContext(),
          "./Counter.solid.mx",
          "/root/src/index.tsx",
        );
        // .tsx (the JSX/print() suffix), not .ts (the .mx-specific suffix) —
        // proves ".solid.mx" won over ".mx" regardless of extensions order.
        expect(resolvedSolidMx).toBe("/root/src/Counter.solid.mx.tsx");

        const resolvedMx = await resolveId.call(
          makeContext(),
          "./greeting.mx",
          "/root/src/index.tsx",
        );
        // .ts, not .tsx: ".mx" alone (not ".solid.mx") routes through
        // compile(), same as ".marko".
        expect(resolvedMx).toBe("/root/src/greeting.mx.ts");
      },
    );
  });
});
