import { readFileSync } from "node:fs";
import { join } from "node:path";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiled templates call `escape` by this name
import { escape } from "@markox/html";
import { compile } from "@markox/translator";

/**
 * Renders a stock `.marko` fixture through `@markox/translator`.
 *
 * The emitted module is TypeScript with ESM imports, which cannot be `eval`ed
 * directly, so both are stripped and the body run with `new Function` —
 * `escape` and any imported component passed in as parameters. The same shape
 * as `mx-html-render.ts`, against the other translator.
 *
 * A `tags/`-discovered component reaches the emitted module as a call to a
 * bare identifier with no import to rewrite, so the discovered `.marko` files
 * beside the fixture are bound by name too.
 */
export function renderTranslator(
  dir: string,
  filename: string,
  input: unknown,
): string {
  const { code } = compile(readFileSync(filename, "utf8"), filename);

  const names: string[] = [];
  const fns: Array<(props: Record<string, unknown>) => string> = [];

  const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+\.marko)"$/gm;
  for (const match of code.matchAll(importRe)) {
    const [, name, relative] = match as unknown as [string, string, string];
    const componentPath = join(dir, relative);
    names.push(name);
    fns.push((props) => renderTranslator(dir, componentPath, props));
  }

  // Tags discovered from `tags/` are called by bare name; bind each one that
  // the emitted code actually calls.
  for (const name of discoveredTags(dir)) {
    if (names.includes(name)) continue;
    if (!new RegExp(`\\b${name}\\(`).test(code)) continue;
    const componentPath = join(dir, "tags", `${name}.marko`);
    names.push(name);
    fns.push((props) => renderTranslator(dir, componentPath, props));
  }

  const body = code
    .replace(/^import\s.*$/gm, "")
    .replace(/^export interface Input \{[\s\S]*?\}$/gm, "")
    .replace(/^export default function \(input: Input\): string \{$/m, "")
    .replace(/\}\s*$/, "");

  const fn = new Function(
    "escape",
    ...names,
    "input",
    `${body}\nreturn out;`,
  ) as (escapeFn: typeof escape, ...rest: unknown[]) => string;

  return fn(escape, ...fns, input);
}

function discoveredTags(dir: string): string[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(join(dir, "tags"))
      .filter((f) => f.endsWith(".marko"))
      .map((f) => f.slice(0, -".marko".length));
  } catch {
    return [];
  }
}
