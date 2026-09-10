import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CompileOptions,
  compileFile,
  MxParserUnavailable,
  VARIANTS,
} from "./compile";
import { lineDiff } from "./diff";
import {
  type DivergenceEntry,
  findDivergence,
  parseDivergences,
} from "./divergences";
import { normalize } from "./normalize";

export type CompareStatus = "pass" | "fail" | "skipped" | "divergent";

export interface CompareResult {
  name: string;
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
 * Compiles input.solid.mx and twin.tsx for every Solid generate variant and
 * compares the normalized output. Also maintains golden snapshots of the
 * twin.tsx output so a babel-preset-solid/solid-js pin bump is caught.
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

  for (const variant of VARIANTS) {
    const variantKey = `${variant.generate}${variant.hydratable ? "-hydratable" : ""}`;
    const twinOutput = normalize(compileFile(twinPath, variant, opts));

    if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
    const goldenPath = join(goldenDir, `twin.${variantKey}.js`);
    let goldenWritten = false;
    if (!existsSync(goldenPath) || opts.updateGoldens) {
      writeFileSync(goldenPath, twinOutput);
      goldenWritten = true;
    }
    const golden = readFileSync(goldenPath, "utf8");
    if (golden !== twinOutput) {
      results.push({
        name,
        variant: variantKey,
        status: "fail",
        diff: lineDiff(golden, twinOutput),
      });
      continue;
    }

    let mxOutput: string;
    try {
      mxOutput = normalize(compileFile(mxPath, variant, opts));
    } catch (err) {
      if (err instanceof MxParserUnavailable) {
        results.push({
          name,
          variant: variantKey,
          status: "skipped",
          goldenWritten,
        });
        continue;
      }
      throw err;
    }

    const divergence = findDivergence(divergences, name, variantKey);
    if (twinOutput === mxOutput) {
      results.push({
        name,
        variant: variantKey,
        status: "pass",
        goldenWritten,
      });
      continue;
    }

    const diff = lineDiff(twinOutput, mxOutput);
    if (divergence) {
      results.push({
        name,
        variant: variantKey,
        status: "divergent",
        diff,
        goldenWritten,
      });
    } else {
      results.push({
        name,
        variant: variantKey,
        status: "fail",
        diff,
        goldenWritten,
      });
    }
  }

  return results;
}
