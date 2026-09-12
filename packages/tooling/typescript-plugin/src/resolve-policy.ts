import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface HostPolicy {
  host: "html" | "astro" | "solid";
  strict?: boolean;
}

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
 * Mirrors the language server's package-policy walk so editor diagnostics and
 * TypeScript virtual files choose the same host for a document.
 */
export function resolveHostPolicy(filePath: string): HostPolicy {
  let directory = dirname(filePath);
  let found: PackageJsonShape | undefined;
  for (;;) {
    found = readPackageJson(join(directory, "package.json"));
    if (found) break;
    const parent = dirname(directory);
    if (parent === directory) return DEFAULT_POLICY;
    directory = parent;
  }

  const { mxlang, dependencies, devDependencies } = found;
  if (mxlang && isKnownHost(mxlang.host)) {
    if (mxlang.host === "translator") {
      console.warn(
        "Warning: The 'translator' mxlang.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
      );
      return { host: "html", strict: mxlang.strict };
    }
    return { host: mxlang.host, strict: mxlang.strict };
  }

  const deps = { ...dependencies, ...devDependencies };
  const hostDeps = Object.keys(HOST_PACKAGES).filter((name) => name in deps);
  if (hostDeps.length === 1) {
    const host = HOST_PACKAGES[hostDeps[0] as string];
    if (host) return { host };
  }
  return DEFAULT_POLICY;
}
