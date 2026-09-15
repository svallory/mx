import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

it("runs the icon custom tag through all six hosts", () => {
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
  expect(result.stdout).toContain("6/6 hosts passed");
  for (const host of ["html", "astro", "preact", "react", "hono", "solid"]) {
    expect(result.stdout).toMatch(new RegExp(`^${host}\\s+pass$`, "m"));
  }
});
