import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compileFile } from "@mxlang/translator";

/**
 * Renders a stock `.marko` fixture through `@mxlang/translator`, by actually
 * loading the emitted module rather than reconstructing its shape.
 *
 * Mirrors `marko-compile-stock.ts`'s approach for the real Marko toolchain:
 * copy the whole fixture directory (`tags/` included, so tag discovery finds
 * the same components), compile every `.marko`/`.mx` file in place to a
 * sibling `.ts`, rewrite each file's own `from "./X.marko"` imports to point
 * at the compiled `.ts` siblings, then `import()` the compiled entry point
 * and call its default export. No parsing of the emitted module's prologue —
 * a change to the import line, the `Input` interface, or the brand no longer
 * breaks this harness the way text-matching the exact shape did (a prologue
 * change to `postEmit` previously reported every fixture as a translator
 * bug).
 *
 * The emitted `escape` import (`from "@mxlang/translator"`, a bare workspace
 * specifier) is rewritten to the package's resolved absolute entry point: a
 * bare specifier resolves by walking up from the *importing file* to a
 * `node_modules`, and the scratch copy lives under the OS tmpdir, outside
 * this repo's `node_modules` ancestry, so it would otherwise fail to
 * resolve. Only the specifier is touched — a plain string substitution on
 * one known import, not a regex over the module's shape.
 */
export async function renderTranslator(
  dir: string,
  filename: string,
  input: unknown,
): Promise<string> {
  const escapeEntry = require.resolve("@mxlang/translator");
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-translator-"));
  try {
    cpSync(dir, scratch, { recursive: true });

    for (const file of markoFiles(scratch)) {
      const { code } = compileFile(file);
      const rewritten = code
        .replace(
          /(from\s+")(\.[^"]+)\.(?:marko|mx)(")/g,
          (_match, prefix, path, suffix) => `${prefix}${path}.ts${suffix}`,
        )
        .replace(
          'from "@mxlang/translator"',
          `from ${JSON.stringify(escapeEntry)}`,
        );

      // A `tags/`-discovered component is called by bare identifier with no
      // import of its own — that is the whole point of tag discovery — so
      // one is synthesized here for each discovered tag the emitted code
      // actually calls, pointing at that tag's own compiled sibling.
      const imports = discoveredTags(dirname(file))
        .filter((name) => new RegExp(`\\b${name}\\(`).test(rewritten))
        .map(
          (name) =>
            `import ${name} from ${JSON.stringify(withTsExtension(join(dirname(file), "tags", `${name}.marko`)))};\n`,
        )
        .join("");

      writeFileSync(withTsExtension(file), imports + rewritten);
    }

    const entry = withTsExtension(join(scratch, relative(dir, filename)));
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => string;
    };
    return mod.default(input);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Every `.marko`/`.mx` file under `dir`, including `tags/`. */
function markoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...markoFiles(full));
    } else if (/\.(?:marko|mx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function withTsExtension(file: string): string {
  return file.replace(/\.(?:marko|mx)$/, ".ts");
}

/** Tag names discoverable from a `tags/` directory beside `dir`, if any. */
function discoveredTags(dir: string): string[] {
  try {
    return readdirSync(join(dir, "tags"))
      .filter((f) => /\.(?:marko|mx)$/.test(f))
      .map((f) => f.replace(/\.(?:marko|mx)$/, ""));
  } catch {
    return [];
  }
}
