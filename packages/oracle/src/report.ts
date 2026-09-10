import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as mxParser } from "@mx/parser";
import { compare } from "./compare";
import { discoverFixtures } from "./fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "..", "..", "fixtures");
const divergencesPath = join(fixturesRoot, "divergences.md");

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const updateGoldens = args.includes("--update");

const fixtures = discoverFixtures(fixturesRoot);
const rows: { name: string; variant: string; status: string }[] = [];
let failed = false;

for (const fixture of fixtures) {
  const results = compare(join(fixturesRoot, fixture), {
    divergencesPath,
    updateGoldens,
    mxParser,
  });
  for (const r of results) {
    rows.push({ name: r.name, variant: r.variant, status: r.status });
    if (r.status === "fail") failed = true;
  }
}

const nameWidth = Math.max(8, ...rows.map((r) => r.name.length));
const variantWidth = Math.max(7, ...rows.map((r) => r.variant.length));
const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));

console.log(
  `${"fixture".padEnd(nameWidth)}  ${"variant".padEnd(variantWidth)}  ${"status".padEnd(statusWidth)}`,
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(nameWidth)}  ${r.variant.padEnd(variantWidth)}  ${r.status.padEnd(statusWidth)}`,
  );
}

const counts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
console.log("");
console.log(
  Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", "),
);

const allSkipped = rows.length > 0 && rows.every((r) => r.status === "skipped");
if (allSkipped) {
  console.log("");
  console.log("ALL SKIPPED: no MX parser wired; this is not a pass.");
}

const hasSkipped = rows.some(
  (r) => r.status === "skipped" || r.status === "pending",
);
if (strict && hasSkipped) failed = true;

process.exit(failed ? 1 : 0);
