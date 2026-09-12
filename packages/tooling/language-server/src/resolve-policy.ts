/**
 * Policy resolution (brief §2, `host-diagnostics.md` §3): which host policy
 * applies to a given file.
 *
 * Rule, in order:
 *
 * 1. Walk upward from the file's directory looking for the nearest
 *    `package.json`. If it has a `"mxlang"` field, that field *is* the
 *    answer: `{ host: "html" | "astro" | "solid", strict?: boolean }` (with "translator" accepted as a deprecated alias).
 * 2. Otherwise, if that same `package.json` depends (in `dependencies` or
 *    `devDependencies`) on exactly one `@mxlang/*` host package
 *    (`@mxlang/html`, `@mxlang/astro`, `@mxlang/solid`; `@mxlang/core` itself does not
 *    count, since every host depends on it too), use that host.
 * 3. Otherwise, fall back to the translator's default (non-strict) policy.
 *
 * This mirrors `Project.loadMeta`'s own `createRequire` + upward
 * `package.json` walk in Marko's language server (`host-diagnostics.md` §1),
 * so the technique is not novel to this package.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostPolicy } from "./diagnose.ts";

const HOST_PACKAGES: Record<string, HostPolicy["host"]> = {
  "@mxlang/html": "html",
  "@mxlang/astro": "astro",
  "@mxlang/solid": "solid",
};

const DEFAULT_POLICY: HostPolicy = { host: "html" };

interface PackageJsonShape {
  mxlang?: { host?: string; strict?: boolean };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function isKnownHost(
  value: unknown,
): value is HostPolicy["host"] | "translator" {
  return (
    value === "html" ||
    value === "translator" ||
    value === "astro" ||
    value === "solid"
  );
}

function readPackageJson(path: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Finds the nearest `package.json` at or above `fileDir`, returning its
 * parsed contents plus the directory it was found in. `undefined` if none is
 * found before the filesystem root.
 */
function findNearestPackageJson(
  fileDir: string,
): { pkg: PackageJsonShape; dir: string } | undefined {
  let dir = fileDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    const pkg = readPackageJson(candidate);
    if (pkg) return { pkg, dir };

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the `HostPolicy` for `filePath` by walking upward from its
 * containing directory. See module doc for the three-branch rule.
 */
export function resolveHostPolicy(filePath: string): HostPolicy {
  const found = findNearestPackageJson(dirname(filePath));
  if (!found) return DEFAULT_POLICY;

  const { mxlang, dependencies, devDependencies } = found.pkg;

  if (mxlang && isKnownHost(mxlang.host)) {
    if (mxlang.host === "translator") {
      console.warn(
        "Warning: The 'translator' mxlang.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
      );
      return { host: "html", strict: mxlang.strict };
    }
    return { host: mxlang.host as HostPolicy["host"], strict: mxlang.strict };
  }

  const deps = { ...dependencies, ...devDependencies };
  const hostDeps = Object.keys(HOST_PACKAGES).filter((name) => name in deps);
  if (hostDeps.length === 1) {
    const host = HOST_PACKAGES[hostDeps[0] as string];
    if (host) return { host };
  }

  return DEFAULT_POLICY;
}
