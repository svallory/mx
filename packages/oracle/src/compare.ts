import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKENDS,
  type CompileOptions,
  compileFile,
  MxParserUnavailable,
  type SolidBackend,
  VARIANTS,
  variantKey,
} from "./compile";
import { lineDiff } from "./diff";
import {
  type DivergenceEntry,
  findDivergence,
  parseDivergences,
} from "./divergences";
import { normalize } from "./normalize";

export type CompareStatus =
  | "pass"
  | "fail"
  | "skipped"
  | "divergent"
  | "pending";

export interface CompareResult {
  name: string;
  backend: SolidBackend;
  variant: string;
  status: CompareStatus;
  diff?: string;
  goldenWritten?: boolean;
}

export interface CompareOptions extends CompileOptions {
  divergencesPath?: string;
  updateGoldens?: boolean;
}

/**
 * Compiles input.solid.mx and twin.tsx for every Solid backend and generate
 * variant, and compares the normalized output. Also maintains golden
 * snapshots of the twin.tsx output so a Solid 2 pin bump is caught.
 *
 * The backend axis is checked because MX must produce output that survives
 * either Solid 2 compiler: `@solidjs/babel-plugin` and the default native
 * `@solidjs/compiler` are separate codegen implementations, so passing one
 * says nothing about the other.
 */
export function compare(
  fixtureDir: string,
  opts: CompareOptions = {},
): CompareResult[] {
  const name = fixtureDir.split("/").filter(Boolean).pop() ?? fixtureDir;
  const twinPath = join(fixtureDir, "twin.tsx");
  const mxPath = join(fixtureDir, "input.solid.mx");
  const goldenDir = join(fixtureDir, "__golden__");

  const divergences: DivergenceEntry[] = opts.divergencesPath
    ? parseDivergences(opts.divergencesPath)
    : [];

  const results: CompareResult[] = [];

  // A fixture carrying a PENDING marker names constructs the parser cannot
  // handle yet. It is reported, never compiled: pending is never a pass and
  // never a failure, and --strict fails on it just like skipped.
  const pendingPath = join(fixtureDir, "PENDING");
  if (existsSync(pendingPath)) {
    for (const backend of BACKENDS) {
      for (const variant of VARIANTS) {
        results.push({
          name,
          backend,
          variant: variantKey(variant),
          status: "pending",
        });
      }
    }
    return results;
  }

  for (const backend of BACKENDS) {
    for (const variant of VARIANTS) {
      const key = variantKey(variant);
      const twinOutput = normalize(
        compileFile(twinPath, variant, backend, opts),
      );

      if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
      const goldenPath = join(goldenDir, `twin.${backend}.${key}.js`);
      let goldenWritten = false;
      if (!existsSync(goldenPath) || opts.updateGoldens) {
        writeFileSync(goldenPath, twinOutput);
        goldenWritten = true;
      }
      const golden = readFileSync(goldenPath, "utf8");
      if (golden !== twinOutput) {
        results.push({
          name,
          backend,
          variant: key,
          status: "fail",
          diff: lineDiff(golden, twinOutput),
        });
        continue;
      }

      let mxOutput: string;
      try {
        mxOutput = normalize(compileFile(mxPath, variant, backend, opts));
      } catch (err) {
        if (err instanceof MxParserUnavailable) {
          results.push({
            name,
            backend,
            variant: key,
            status: "skipped",
            goldenWritten,
          });
          continue;
        }
        throw err;
      }

      const divergence = findDivergence(divergences, name, key);
      if (twinOutput === mxOutput) {
        results.push({
          name,
          backend,
          variant: key,
          status: "pass",
          goldenWritten,
        });
        continue;
      }

      const diff = lineDiff(twinOutput, mxOutput);
      results.push({
        name,
        backend,
        variant: key,
        status: divergence ? "divergent" : "fail",
        diff,
        goldenWritten,
      });
    }
  }

  return results;
}
