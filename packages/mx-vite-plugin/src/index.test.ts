import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * The three hooks under test, called directly. Vite passes the plugin context
 * as `this`; none of these hooks use it, so an empty object stands in.
 */
interface Hooks {
  resolveId(id: string, importer?: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string): TransformResult | null;
}

function hooksOf(plugin: ReturnType<typeof mx>): Hooks {
  const { resolveId, load, transform } = plugin;
  if (
    typeof resolveId !== "function" ||
    typeof load !== "function" ||
    typeof transform !== "function"
  ) {
    throw new Error("expected mx() to register function hooks");
  }
  const context = {};
  return {
    resolveId: (id, importer) =>
      (resolveId as (this: unknown, ...a: unknown[]) => string | null).call(
        context,
        id,
        importer,
      ),
    load: (id) =>
      (load as (this: unknown, ...a: unknown[]) => string | null).call(
        context,
        id,
      ),
    transform: (code, id) =>
      (
        transform as (this: unknown, ...a: unknown[]) => TransformResult | null
      ).call(context, code, id),
  };
}

/** Writes `source` to a real temp file, since `load` reads from disk. */
function writeMx(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-plugin-"));
  const path = join(dir, name);
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
    it("rewrites a relative .solid.mx import to a .tsx-suffixed id", () => {
      const { resolveId } = hooksOf(mx());

      const resolved = resolveId("./Counter.solid.mx", "/app/src/index.tsx");

      expect(resolved).toBe(`/app/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("resolves an import made from an already-rewritten MX module", () => {
      const { resolveId } = hooksOf(mx());

      // App.solid.mx imports ./Counter.solid.mx; the importer Vite passes is
      // the suffixed id, so the suffix must be stripped before joining.
      const resolved = resolveId(
        "./Counter.solid.mx",
        `/app/src/App.solid.mx${MX_SUFFIX}`,
      );

      expect(resolved).toBe(`/app/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("leaves ids it does not handle alone", () => {
      const { resolveId } = hooksOf(mx());
      const importer = "/app/src/index.tsx";

      expect(resolveId("./main.tsx", importer)).toBeNull();
      expect(resolveId("solid-js", importer)).toBeNull();
    });
  });

  describe("load", () => {
    it("reads the real .solid.mx file behind the suffixed id", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const { load } = hooksOf(mx());

      expect(load(path + MX_SUFFIX)).toBe(COUNTER);
      expect(load("/app/src/main.tsx")).toBeNull();
    });
  });

  describe("transform", () => {
    it("prints a .solid.mx module to JSX text plus a map", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const { transform } = hooksOf(mx());

      const result = transform(COUNTER, path + MX_SUFFIX);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
      expect(result?.code).toContain("onClick={");
      // The MX placeholder must have become a JSX expression child.
      expect(result?.code).toContain("{count()}");
      expect(result?.code).not.toContain(`\${count()}`);
      expect(result?.map).toMatchObject({ version: 3 });
    });

    it("names the .solid.mx file, not the .tsx id, in the source map", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const { transform } = hooksOf(mx());

      const result = transform(COUNTER, path + MX_SUFFIX);
      const map = result?.map as { sources: string[] };

      expect(map.sources).toContain(path);
    });

    it("strips a query string before matching the id", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const { transform } = hooksOf(mx());

      const result = transform(COUNTER, `${path}${MX_SUFFIX}?t=1712345`);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
    });

    it("returns null for ids it does not handle", () => {
      const { transform } = hooksOf(mx());
      const code = "export const a = 1;";

      expect(transform(code, "/src/main.tsx")).toBeNull();
      expect(transform(code, "/src/main.ts")).toBeNull();
      expect(transform("body {}", "/src/app.css")).toBeNull();
    });

    it("throws a Vite-shaped error with loc for a broken .solid.mx", () => {
      const path = writeMx("Broken.solid.mx", BROKEN);
      const { transform } = hooksOf(mx());

      let caught: unknown;
      try {
        transform(BROKEN, path + MX_SUFFIX);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        loc?: { file: string; line: number; column: number };
      };
      expect(error.loc).toBeDefined();
      // The overlay must point at the .solid.mx source, not the internal id.
      expect(error.loc?.file).toBe(path);
      // The mismatched closing tag is on line 3 of BROKEN.
      expect(error.loc?.line).toBe(3);
      expect(typeof error.loc?.column).toBe("number");
    });
  });
});
