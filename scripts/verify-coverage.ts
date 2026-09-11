#!/usr/bin/env bun
//
// decision 64: `verify` must prove every non-exception package's tests
// actually ran in *this* invocation, not merely that some test wiring exists
// for it somewhere. Every "ran" verdict below is read from an evidence file
// written by the real test command during this same `bun run verify` call
// (scripts/pre-verify.ts deletes stale evidence first) — there is no branch
// that marks a package as tested without checking that evidence.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const root = `${import.meta.dir}/../`;
const vitestJsonPath = join(root, "vitest-results.json");
const grammarMarkerPath = join(root, "packages/tree-sitter-solidmx/.test-ran");
const verifyStartPath = join(root, ".verify-start");

interface Package {
  name: string;
  type: "package" | "example";
  path: string;
  reason?: string;
}

const NO_TEST_EXCEPTIONS: Record<string, string> = {
  "astro-static": "e2e only",
  "counter-app": "e2e only",
  "mx-site": "e2e only",
  "mx-vite": "e2e only",
  todomvc: "e2e only",
  "zed-extension":
    "grammar and Rust extension, both build-verified in CI (zed-compile-check, zed-extension-compile-check)",
};

// The one package whose real test (packages/tree-sitter-solidmx/scripts/test.sh,
// run via `moon run tree-sitter-solidmx:test`) is not vitest and so can never
// appear in vitest-results.json — it's checked against its own marker file.
const GRAMMAR_MARKER_PACKAGE = "tree-sitter-solidmx";

function readPackageJson(dir: string): Record<string, unknown> | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

async function getPackages(): Promise<Package[]> {
  const packages: Package[] = [];
  const rootPkg = readPackageJson(root);
  const workspaces = rootPkg?.workspaces;
  if (!Array.isArray(workspaces)) {
    console.error("No workspaces found in root package.json");
    process.exit(1);
  }

  const workspaceDirs = new Set<string>();

  for (const pattern of workspaces) {
    const base =
      pattern === "packages/*"
        ? "packages"
        : pattern === "examples/*"
          ? "examples"
          : null;
    if (!base) continue;
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        existsSync(join(dir, entry.name, "package.json"))
      ) {
        workspaceDirs.add(join(base, entry.name));
      }
    }
  }

  for (const relPath of Array.from(workspaceDirs).sort()) {
    const nameParts = relPath.split("/");
    const name = nameParts[nameParts.length - 1];
    const type = relPath.startsWith("examples/") ? "example" : "package";
    const baseName = `${type === "example" ? "examples/" : ""}${name}`;

    packages.push({
      name: baseName,
      type,
      path: relPath,
      reason: NO_TEST_EXCEPTIONS[name],
    });
  }

  return packages;
}

function formatRow(name: string, wiring: string, status: string): string {
  return name.padEnd(30) + wiring.padEnd(35) + status;
}

interface VitestResult {
  testResults: Array<{
    name: string;
    assertionResults: Array<{ status: string }>;
  }>;
}

// Any evidence file must be newer than the moment this verify invocation
// started (written by scripts/pre-verify.ts), or it's a leftover from a
// previous run that pre-verify somehow failed to clear — reject it rather
// than trust it.
function isFreshEvidence(path: string, verifyStart: number): boolean {
  if (!existsSync(path)) return false;
  return statSync(path).mtimeMs >= verifyStart;
}

function getTestedPackagesFromVitest(verifyStart: number): Set<string> {
  const tested = new Set<string>();

  if (!isFreshEvidence(vitestJsonPath, verifyStart)) {
    return tested;
  }

  const content = JSON.parse(
    readFileSync(vitestJsonPath, "utf-8"),
  ) as VitestResult;
  if (!content.testResults) return tested;

  for (const result of content.testResults) {
    const fullPath = result.name;
    const pkgMatch =
      fullPath.match(/\/packages\/([^/]+)\//) ||
      fullPath.match(/\/examples\/([^/]+)\//);
    if (pkgMatch && result.assertionResults?.length > 0) {
      tested.add(pkgMatch[1]);
    }
  }

  return tested;
}

async function main() {
  if (!existsSync(verifyStartPath)) {
    console.error(
      "ERROR: .verify-start is missing. Run via `bun run verify` (scripts/pre-verify.ts writes it), not this script directly against a stale worktree.\n",
    );
    process.exit(1);
  }
  const verifyStart = Number(readFileSync(verifyStartPath, "utf-8").trim());

  const packages = await getPackages();

  console.log("\n=== Test Coverage Verification ===\n");
  console.log(formatRow("Package", "Test Wiring", "Ran"));
  console.log("-".repeat(75));

  const testedPackages = getTestedPackagesFromVitest(verifyStart);
  const grammarRan = isFreshEvidence(grammarMarkerPath, verifyStart);

  let hasFailure = false;
  let ranCount = 0;
  const exceptions: Package[] = [];

  for (const pkg of packages) {
    const shortName = pkg.name.replace("examples/", "");

    if (pkg.reason) {
      exceptions.push(pkg);
      console.log(formatRow(pkg.name, `(exception: ${pkg.reason})`, "OK"));
      continue;
    }

    if (shortName === GRAMMAR_MARKER_PACKAGE) {
      if (grammarRan) {
        ranCount++;
        console.log(
          formatRow(pkg.name, "moon test task (scripts/test.sh)", "ran"),
        );
      } else {
        hasFailure = true;
        console.log(
          formatRow(
            pkg.name,
            "moon test task (scripts/test.sh)",
            "ERROR: did not run",
          ),
        );
      }
      continue;
    }

    if (testedPackages.has(shortName)) {
      ranCount++;
      console.log(formatRow(pkg.name, "vitest project", "ran"));
    } else {
      hasFailure = true;
      console.log(
        formatRow(pkg.name, "vitest project", "ERROR: no evidence it ran"),
      );
    }
  }

  console.log(`\n${"=".repeat(75)}`);
  console.log(
    `Total: ${packages.length} packages (${ranCount} ran, ${exceptions.length} exceptions)\n`,
  );

  if (exceptions.length > 0) {
    console.log("Exceptions (no test required):");
    for (const exc of exceptions) {
      console.log(`  • ${exc.name}: ${exc.reason}`);
    }
    console.log();
  }

  if (hasFailure) {
    console.error(
      "ERROR: one or more packages have no test wiring, or no fresh evidence their tests ran in this invocation.\n",
    );
    process.exit(1);
  }

  console.log(
    "✓ All packages have test wiring and fresh evidence their tests ran.\n",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
