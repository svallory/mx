import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const HOSTS = ["html", "astro", "preact", "react", "hono", "solid"] as const;

/**
 * The two fixtures are the same `<icon>` written two ways: an L2 sidecar that
 * builds IR with the tag builders, and an L1 template inlined from
 * `tags/icon.mx`. Asserting every row of both is what proves a template tag
 * reaches a host as ordinary IR — no host emitter knows which layer authored
 * the markup it rendered.
 */
const FIXTURES = ["icon", "icon-template"] as const;

it("runs both icon custom tag fixtures through all six hosts", () => {
  const result = spawnSync(
    "bun",
    [
      "run",
      "--tsconfig-override=tsconfig.base.json",
      "packages/oracle/fixtures-custom-tags/run.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  // Decision 55: assert the count, so a fixture or a host that silently
  // stopped running is a failure rather than an unnoticed absence.
  expect(result.stdout).toContain("12/12 rows passed");
  for (const fixture of FIXTURES) {
    for (const host of HOSTS) {
      expect(result.stdout).toMatch(
        new RegExp(`^${fixture}\\s+${host}\\s+pass$`, "m"),
      );
    }
  }
});
