import { $ } from "bun";
import { collectMxRegions } from "../../../parser/src/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "node:fs/promises";

// Emulate the find command used in parse-all.sh
const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "../../../..");
const LOCAL_FIXTURES = join(HERE, "../fixtures");

async function findFiles(): Promise<string[]> {
  const dirs = [
    join(REPO_ROOT, "fixtures"),
    join(REPO_ROOT, "examples"),
    LOCAL_FIXTURES,
  ];

  const files: string[] = [];
  for (const dir of dirs) {
    try {
      const globFiles = await Array.fromAsync(glob("**/*.solid.mx", { cwd: dir }));
      for (const file of globFiles) {
        files.push(join(dir, file));
      }
    } catch {
      // Ignore missing directories
    }
  }
  return files.sort();
}

function offsetAt(source: string, line: number, column: number): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < source.length) {
    if (source.charCodeAt(offset++) === 10) currentLine++;
  }
  return Math.min(source.length, offset + column);
}

async function run() {
  const files = await findFiles();
  let totalFiles = 0;
  let totalRegions = 0;
  let mismatches = 0;

  for (const file of files) {
    totalFiles++;
    const source = readFileSync(file, "utf8");

    // 1. Get Tree-sitter regions
    const xml = await $`bunx tree-sitter parse -x ${file}`.quiet().text();
    const tsRegions: { start: number; end: number }[] = [];
    const regex = /<mx_element[^>]*srow="(\d+)" scol="(\d+)" erow="(\d+)" ecol="(\d+)"/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const srow = Number.parseInt(match[1], 10);
      const scol = Number.parseInt(match[2], 10);
      const erow = Number.parseInt(match[3], 10);
      const ecol = Number.parseInt(match[4], 10);
      tsRegions.push({
        start: offsetAt(source, srow, scol),
        end: offsetAt(source, erow, ecol),
      });
    }

    // 2. Get Walker regions
    const walkerRegions = collectMxRegions(source, file);

    // 3. Compare
    let mismatch = false;
    if (tsRegions.length !== walkerRegions.length) {
      mismatch = true;
    } else {
      for (let i = 0; i < tsRegions.length; i++) {
        if (
          tsRegions[i].start !== walkerRegions[i].start ||
          tsRegions[i].end !== walkerRegions[i].end
        ) {
          mismatch = true;
          break;
        }
      }
    }

    totalRegions += tsRegions.length;

    if (mismatch) {
      mismatches++;
      console.error(`\nMismatch in ${file}`);
      console.error("  Tree-sitter found:");
      tsRegions.forEach((r) => console.error(`    [${r.start}, ${r.end})`));
      console.error("  Walker found:");
      walkerRegions.forEach((r) => console.error(`    [${r.start}, ${r.end})`));

      // Find first differing region
      const maxLen = Math.max(tsRegions.length, walkerRegions.length);
      for (let i = 0; i < maxLen; i++) {
        const tr = tsRegions[i];
        const wr = walkerRegions[i];
        if (!tr || !wr || tr.start !== wr.start || tr.end !== wr.end) {
          console.error(`\n  First differing region (index ${i}):`);
          if (tr) {
            console.error(
              `  Tree-sitter range [${tr.start}, ${tr.end}):\n    ${JSON.stringify(
                source.slice(Math.max(0, tr.start - 20), tr.start) +
                  "|" +
                  source.slice(tr.start, tr.end) +
                  "|" +
                  source.slice(tr.end, Math.min(source.length, tr.end + 20)),
              )}`,
            );
          }
          if (wr) {
            console.error(
              `  Walker range      [${wr.start}, ${wr.end}):\n    ${JSON.stringify(
                source.slice(Math.max(0, wr.start - 20), wr.start) +
                  "|" +
                  source.slice(wr.start, wr.end) +
                  "|" +
                  source.slice(wr.end, Math.min(source.length, wr.end + 20)),
              )}`,
            );
          }
          break;
        }
      }
    }
  }

  console.log(
    `differential: ${totalFiles} files, ${totalRegions} regions, ${mismatches} mismatches`,
  );
  if (mismatches > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
