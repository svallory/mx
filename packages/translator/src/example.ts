/**
 * `bun run example` — compiles one fixture and renders it to stdout.
 *
 * Deliberately not an app: it shows the whole product in one screen, which is
 * a compiled module with no runtime but `escape`, and the HTML it produces.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiled templates call `escape` by this name, so the harness must bind it under the same one
import { escape } from "@markox/html";
import { compileFile } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = process.argv[2] ?? "class-object";
const dir = join(here, "..", "fixtures-marko", fixture);

const { code } = compileFile(join(dir, "input.marko"));
const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));

console.log(`--- ${fixture}/input.marko ---`);
console.log(readFileSync(join(dir, "input.marko"), "utf8").trimEnd());
console.log(`\n--- compiled module ---`);
console.log(code.trimEnd());
console.log(`\n--- rendered with ${JSON.stringify(input)} ---`);
console.log(render(code, dir, input));

/**
 * Runs an emitted module without a bundler.
 *
 * The output is TypeScript with ESM imports; both are stripped and the
 * remaining body run with `new Function`, `escape` passed in as a parameter.
 * Exactly what the fixture harness does, kept here so the example needs no
 * build step.
 */
function render(code: string, dir: string, input: unknown): string {
  const componentNames: string[] = [];
  const componentFns: Array<(props: Record<string, unknown>) => string> = [];

  const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+\.marko)"$/gm;
  for (const match of code.matchAll(importRe)) {
    const [, name, relative] = match as unknown as [string, string, string];
    const { code: componentCode } = compileFile(join(dir, relative));
    componentNames.push(name);
    componentFns.push((props) => render(componentCode, dir, props));
  }

  const body = code
    .replace(/^import\s.*$/gm, "")
    .replace(/^export interface Input \{[\s\S]*?\}$/gm, "")
    .replace(/^export default function \(input: Input\): string \{$/m, "")
    .replace(/\}\s*$/, "");

  const fn = new Function(
    "escape",
    ...componentNames,
    "input",
    `${body}\nreturn out;`,
  ) as (escapeFn: typeof escape, ...rest: unknown[]) => string;

  return fn(escape, ...componentFns, input);
}
