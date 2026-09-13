import { runReactTable } from "./report-react";

const strict = process.argv.slice(2).includes("--strict");
const { failed } = await runReactTable();

if (strict) console.log("(--strict: recorded skips do not fail)");

process.exit(failed ? 1 : 0);
