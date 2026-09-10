import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWithMarko } from "./marko-compile";
import { renderMxHtml } from "./mx-html-render";
import { htmlEquals } from "./normalize-html";
import { runStockTable } from "./report-marko-stock";

/**
 * `oracle:marko` (decision 51/55): parity check between Marko's own
 * toolchain and `@markox/html`'s output for the standalone `fixtures-mx`
 * set. Each is rendered to HTML, normalized with `normalizeHtml`, and
 * compared against `expected.html`. A mismatch is classified via an optional
 * `meta.json` in the fixture directory (see fixtures/README.md's "Marko
 * column semantics" section):
 *
 *   { "marko": "skip", "reason": "..." }        — never compiled, always listed "skipped (reason)"
 *   { "marko": "divergence", "reason": "..." }  — compiled, mismatch expected and cited
 *
 * A fixture with neither key is expected to match both ways; a mismatch
 * there is an unrecorded `mx bug` or `marko divergence` and always fails the
 * run, `--strict` or not — it has no classification yet. A recorded,
 * reasoned skip/divergence does not fail even `--strict`: that is the point
 * of the classification, unlike `oracle -- --strict`'s own rule (which fails
 * on any `pending`/`skipped` fixture) — here `meta.json` is the mechanism for
 * marking a fixture settled, not a marker of unfinished work.
 *
 * Decision 55 (lead rule): a gating check must assert it did work, not only
 * that it found no failures. This exits non-zero — in both normal and
 * `--strict` mode — if the fixture glob expands to nothing, if any fixture
 * directory is missing one of its three required files, or if fewer than 30
 * fixtures were actually processed, so a broken glob or an accidentally
 * empty fixtures-mx directory cannot read as a silent pass.
 */

const MIN_FIXTURES = 30;

interface FixtureMeta {
  marko?: "skip" | "divergence";
  reason?: string;
}

type Verdict = "pass" | "mx bug" | "skipped (reason)";

interface Row {
  fixture: string;
  marko: string;
  mxHtml: string;
  verdict: Verdict;
  detail?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "..", "mx-html", "fixtures-mx");

const args = process.argv.slice(2);
const strict = args.includes("--strict");

if (!existsSync(fixturesRoot)) {
  console.error(`oracle:marko: fixtures root not found: ${fixturesRoot}`);
  process.exit(1);
}

const entries = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (entries.length === 0) {
  console.error(
    `oracle:marko: fixtures glob expanded to nothing under ${fixturesRoot}`,
  );
  process.exit(1);
}

let malformed = false;
for (const name of entries) {
  const dir = join(fixturesRoot, name);
  for (const file of ["input.mx", "input.json", "expected.html"]) {
    if (!existsSync(join(dir, file))) {
      console.error(`oracle:marko: fixture "${name}" is missing ${file}`);
      malformed = true;
    }
  }
}
if (malformed) process.exit(1);

const rows: Row[] = [];
let hasUnresolvedMismatch = false;

for (const name of entries) {
  const dir = join(fixturesRoot, name);
  const metaPath = join(dir, "meta.json");
  const meta: FixtureMeta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as FixtureMeta)
    : {};

  if (meta.marko === "skip") {
    if (!meta.reason) {
      console.error(
        `oracle:marko: fixture "${name}" has marko:"skip" with no reason`,
      );
      malformed = true;
    }
    rows.push({
      fixture: name,
      marko: "skipped (reason)",
      mxHtml: "skipped (reason)",
      verdict: "skipped (reason)",
      detail: meta.reason,
    });
    continue;
  }

  const input = JSON.parse(
    readFileSync(join(dir, "input.json"), "utf8"),
  ) as unknown;
  const expected = readFileSync(join(dir, "expected.html"), "utf8");
  const mxSource = readFileSync(join(dir, "input.mx"), "utf8");

  let markoStatus: string;
  try {
    markoStatus = htmlEquals(await renderWithMarko(dir, input), expected)
      ? "pass"
      : "mismatch";
  } catch (err) {
    markoStatus = `error: ${(err as Error).message.slice(0, 60)}`;
  }

  let mxStatus: string;
  try {
    mxStatus = htmlEquals(renderMxHtml(dir, mxSource, input), expected)
      ? "pass"
      : "mismatch";
  } catch (err) {
    mxStatus = `error: ${(err as Error).message.slice(0, 60)}`;
  }

  const bothPass = markoStatus === "pass" && mxStatus === "pass";

  let verdict: Verdict;
  let detail: string | undefined;
  if (bothPass) {
    verdict = "pass";
  } else if (meta.marko === "divergence") {
    verdict = "skipped (reason)";
    detail = meta.reason;
  } else {
    verdict = "mx bug";
    detail = "unclassified: mismatch or error with no meta.json entry";
    hasUnresolvedMismatch = true;
  }

  rows.push({
    fixture: name,
    marko: markoStatus,
    mxHtml: mxStatus,
    verdict,
    detail,
  });
}

const processed = rows.length;

const nameWidth = Math.max(8, ...rows.map((r) => r.fixture.length));
console.log(
  `${"fixture".padEnd(nameWidth)}  marko            mx-html          verdict`,
);
for (const r of rows) {
  console.log(
    `${r.fixture.padEnd(nameWidth)}  ${r.marko.padEnd(15)}  ${r.mxHtml.padEnd(15)}  ${r.verdict}${r.detail ? `  (${r.detail})` : ""}`,
  );
}

const passCount = rows.filter((r) => r.verdict === "pass").length;
const skippedCount = rows.filter(
  (r) => r.verdict === "skipped (reason)",
).length;
const bugCount = rows.filter((r) => r.verdict === "mx bug").length;

console.log("");
console.log(
  `processed: ${processed} fixtures (minimum required: ${MIN_FIXTURES}) — ${passCount} pass, ${skippedCount} skipped(reason), ${bugCount} mx bug`,
);

// Decision 66's second table: the same parity question asked of stock
// `.marko` templates through `@markox/translator`. Kept in its own module so
// the two tables cannot entangle: the `.mx` set carries a dozen recorded
// divergences by design, while the stock set is expected to match Marko
// outright.
const stock = await runStockTable();

let failed = malformed || hasUnresolvedMismatch || stock.failed;

if (processed < MIN_FIXTURES) {
  console.error(
    `oracle:marko: only ${processed} fixtures processed, below the required minimum of ${MIN_FIXTURES} — treating as a failed run, not a pass`,
  );
  failed = true;
}

// `--strict` does not fail on a recorded, reasoned skip/divergence — that is
// the point of meta.json classification. It fails on the same things the
// non-strict run already fails on: an unclassified mismatch, a malformed
// meta.json, or too few fixtures processed. Accepted (and echoed) for
// symmetry with `oracle -- --strict`'s CLI contract.
if (strict) console.log("(--strict: recorded skips/divergences do not fail)");

process.exit(failed ? 1 : 0);
