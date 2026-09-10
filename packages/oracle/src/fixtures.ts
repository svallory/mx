import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Lists fixture directory names under `fixturesRoot`, sorted. */
export function discoverFixtures(fixturesRoot: string): string[] {
  return readdirSync(fixturesRoot)
    .filter((entry) => statSync(join(fixturesRoot, entry)).isDirectory())
    .filter((entry) => entry !== "__golden__")
    .sort();
}
