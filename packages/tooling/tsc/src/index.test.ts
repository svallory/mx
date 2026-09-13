import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { consumeAstroFlag, resolveTscPath } from "./index.ts";

/**
 * Each of these tests spawns a real `tsc`, which takes ~1s alone but well past
 * vitest's 5s default when the whole root suite runs in parallel on a loaded
 * machine. The budget is generous on purpose: a slow machine is not a
 * regression, and a flaky gate is worse than a slow one.
 */
const SPAWN_TIMEOUT_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const fixtures = join(here, "fixtures");
const astroStatic = join(repoRoot, "examples", "astro-static");

/**
 * `mx-tsc` is a real `tsc` with Volar's program proxy spliced in, so there is
 * no in-process surface to assert against: the thing under test *is* the
 * process's diagnostics and exit code. These tests therefore run the built
 * entry point, which means `bun run build` must have produced `dist/bin.cjs`
 * first — the same fresh-worktree caveat `@mxlang/parser`'s `dist/index.js`
 * carries.
 *
 * `dist/bin.cjs` directly, not `node_modules/.bin/mx-tsc`: bun creates a bin
 * symlink at *install* time and silently skips one whose target does not exist
 * yet. In CI `bun install` always runs before `bun run build`, so that symlink
 * is never created there — which is exactly how this was found (`mx-tsc:
 * command not found`, on a machine where the local link existed from an
 * earlier build). Running the file needs no linking at all.
 *
 * `node`, not bun: `runTsc` reads and re-evaluates TypeScript's own `tsc.js`
 * as CommonJS, which bun's loader does not reproduce faithfully.
 */
const mxTsc = join(repoRoot, "packages", "tooling", "tsc", "dist", "bin.cjs");
const plainTsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

interface Run {
  status: number;
  output: string;
}

function run(entry: string, args: string[]): Run {
  try {
    const output = execFileSync(process.execPath, [entry, ...args], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (cause) {
    const error = cause as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("mx-tsc", () => {
  it("has a built entry point to exercise", () => {
    expect(existsSync(mxTsc)).toBe(true);
  });

  it("resolves TypeScript's own tsc entry point", () => {
    expect(resolveTscPath()).toMatch(/typescript[/\\]lib[/\\]tsc\.js$/);
  });

  it("consumes --astro before TypeScript sees the command line", () => {
    const argv = ["node", "mx-tsc", "--noEmit", "--astro", "--astro"];

    expect(consumeAstroFlag(argv)).toBe(true);
    expect(argv).toEqual(["node", "mx-tsc", "--noEmit"]);
    expect(consumeAstroFlag(argv)).toBe(false);
  });

  it(
    "type-checks a valid .solid.mx and its importer with --noEmit",
    () => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, "passing")]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a type error inside an MX region at its own position",
    () => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, "failing")]);

      expect(result.status).not.toBe(0);
      // The error is inside the `.solid.mx` file itself, not the importer, and
      // lands on the offending argument rather than the region's opening tag.
      expect(result.output).toContain("Widget.solid.mx(7,32)");
      expect(result.output).toContain("error TS2345");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a type error in a whole-file MX static block",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "hoisted-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // Line 2, column 14 is `bogus` in the source `.mx` file: the diagnostic
      // is reported against the author's own `static` line, not against the
      // generated module's line numbering.
      expect(result.output).toContain("StaticError.mx(2,14): error TS2322");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "catches what plain tsc cannot even see",
    () => {
      const result = run(plainTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "failing"),
      ]);

      // Plain `tsc` never opens the file: it fails at the *import* instead, and
      // so reports nothing about the type error the module actually contains.
      expect(result.output).toContain("error TS2307");
      expect(result.output).not.toContain("TS2345");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed .mx component prop from an Astro file",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong .mx component prop in an Astro file",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("wrong-prop.astro(5,7): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed .amx page in Astro mode",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports .amx prop and interpolation errors at exact source columns",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("amx-wrong.amx(8,7): error TS2322");
      expect(result.output).toContain("amx-wrong.amx(9,27): error TS2345");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
      expect(result.output).toContain(
        "Argument of type 'string' is not assignable to parameter of type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a .amx fence error at its exact source column",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-fence-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("amx-fence-wrong.amx(2,7): error TS2322");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
