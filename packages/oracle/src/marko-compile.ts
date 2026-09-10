import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFile } from "@marko/compiler";
import * as translator from "marko/translator";

/**
 * Renders `<name>/input.mx` (and any sibling `.mx` files it imports) through
 * the real Marko 6 toolchain, for the `oracle:marko` parity check.
 *
 * MX's `.mx` extension is unknown to Marko, so every source file involved is
 * copied to a scratch directory with a `.marko` extension and its `import ...
 * from "./x.mx"` lines rewritten to `"./x.marko"` before compiling. Only a
 * fixture's own directory is scanned for imports — good enough for the
 * standalone fixture set, which never reaches outside its own directory.
 */
export async function renderWithMarko(
  fixtureDir: string,
  input: unknown,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-marko-"));
  const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+)\.mx"$/gm;

  // Marko has no notion of `.mx`, so every source file involved — the
  // fixture's `input.mx` and any sibling `.mx` it imports — is copied to a
  // `.marko` file with its own imports rewritten to `.mjs` (not `.marko`):
  // Marko's runtime loader has no way to compile a raw `.marko` file loaded
  // via a plain `import`, so each one is compiled ahead of time to a sibling
  // `.mjs`, and components reference each other by that compiled path.
  const relativeNames = new Set<string>();
  function discover(relativeName: string): void {
    if (relativeNames.has(relativeName)) return;
    relativeNames.add(relativeName);
    const source = readFileSync(join(fixtureDir, `${relativeName}.mx`), "utf8");
    for (const match of source.matchAll(importRe)) {
      const importPath = match[2] as string;
      discover(importPath.replace(/^\.\//, ""));
    }
  }
  discover("input");

  for (const relativeName of relativeNames) {
    const source = readFileSync(join(fixtureDir, `${relativeName}.mx`), "utf8");
    const rewritten = source.replace(
      importRe,
      (_m, name: string, importPath: string) =>
        `import ${name} from "${importPath}.mjs"`,
    );
    writeFileSync(join(scratch, `${relativeName}.marko`), rewritten);
  }

  for (const relativeName of relativeNames) {
    const compiled = await compileFile(join(scratch, `${relativeName}.marko`), {
      translator,
      output: "html",
      modules: "esm",
      // Without this, Marko emits resume/hydration markers (an HTML comment
      // plus a <script> reviving them) even for a pure server-html render —
      // noise this parity check has no interest in comparing.
      optimize: true,
    });
    writeFileSync(join(scratch, `${relativeName}.mjs`), compiled.code);
  }

  const mod = (await import(join(scratch, "input.mjs"))) as {
    default: { render: (input: unknown) => { toString(): string } | string };
  };
  const rendered = mod.default.render(input);
  return typeof rendered === "string" ? rendered : String(await rendered);
}
