import { runPreactTable } from "./report-preact";

/**
 * `bun run oracle:preact` — see `report-preact.ts` for what this table
 * asserts and how a skip is justified.
 *
 * `--strict` is accepted for CLI symmetry with `oracle -- --strict` and
 * `oracle:marko -- --strict`, and like the latter does not fail on a
 * recorded, reasoned skip: a construct this host declares unsupported is the
 * settled state, not unfinished work.
 */
const strict = process.argv.slice(2).includes("--strict");

const { failed } = await runPreactTable();

if (strict) console.log("(--strict: recorded skips do not fail)");

process.exit(failed ? 1 : 0);
