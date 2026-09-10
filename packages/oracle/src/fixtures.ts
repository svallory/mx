import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Lists fixture directory names under `fixturesRoot`, sorted. A fixture
 * directory must contain both input.solid.mx and twin.tsx; a directory
 * with only one of the two is a malformed fixture and throws.
 */
export function discoverFixtures(fixturesRoot: string): string[] {
  const dirs = readdirSync(fixturesRoot)
    .filter((entry) => statSync(join(fixturesRoot, entry)).isDirectory())
    .filter((entry) => entry !== "__golden__")
    .sort();

  for (const dir of dirs) {
    const hasMx = existsSync(join(fixturesRoot, dir, "input.solid.mx"));
    const hasTwin = existsSync(join(fixturesRoot, dir, "twin.tsx"));
    if (hasMx !== hasTwin) {
      throw new Error(
        `fixture "${dir}" has only one of input.solid.mx / twin.tsx; both are required`,
      );
    }
  }

  return dirs.filter((dir) => existsSync(join(fixturesRoot, dir, "twin.tsx")));
}
