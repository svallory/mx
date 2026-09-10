import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { compile } from "@markox/html";

const pagesDir = join(import.meta.dirname, "pages");
const genDir = join(import.meta.dirname, "..", ".gen", "pages");

/** Rewrites relative `./x.mx` import specifiers to point at the compiled `./x.mx.ts` sibling. */
function rewriteImports(code: string): string {
  return code.replace(/from "(\.[^"]*\.mx)"/g, 'from "$1.ts"');
}

function findMxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findMxFiles(full));
    } else if (entry.endsWith(".mx")) {
      out.push(full);
    }
  }
  return out;
}

/** Compiles every `.mx` page under `src/pages` to `.gen/pages`, mirroring the directory layout. */
export function compilePages(): string[] {
  const files = findMxFiles(pagesDir);
  const written: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const { code } = compile(source, file);
    const rel = relative(pagesDir, file);
    const outPath = join(genDir, `${rel}.ts`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rewriteImports(code));
    written.push(outPath);
  }

  return written;
}

/** A compiled page module's shape: render `input` to an HTML string. */
export type PageModule<Input> = { default: (input: Input) => string };

/**
 * Loads a compiled page by name from `.gen/pages`.
 *
 * The import specifier is built at runtime rather than written as a static
 * literal so `tsc` does not try to resolve it against `.gen/pages`, which
 * only exists after `compilePages()` has run.
 */
export async function loadPage<Input>(
  name: string,
): Promise<PageModule<Input>["default"]> {
  const path = join(genDir, `${name}.mx.ts`);
  const mod = (await import(path)) as PageModule<Input>;
  return mod.default;
}

if (import.meta.main) {
  const written = compilePages();
  for (const path of written) {
    console.log(`compiled ${relative(join(import.meta.dirname, ".."), path)}`);
  }
}
