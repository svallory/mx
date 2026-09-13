import { runHonoTable } from "./report-hono";

/**
 * `bun run oracle:hono` — see `report-hono.ts`/`report-preact.ts` for what
 * this table asserts and how a skip is justified.
 *
 * `--strict` is accepted for CLI symmetry with `oracle -- --strict` and
 * `oracle:marko -- --strict`, and like the latter does not fail on a
 * recorded, reasoned skip: a construct this host declares unsupported is the
 * settled state, not unfinished work.
 */
const strict = process.argv.slice(2).includes("--strict");

const { failed } = await runHonoTable();

if (strict) console.log("(--strict: recorded skips do not fail)");

process.exit(failed ? 1 : 0);
