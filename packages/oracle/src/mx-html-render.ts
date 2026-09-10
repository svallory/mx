import { readFileSync } from "node:fs";
import { join } from "node:path";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiled templates call `escape` by this name
import { compile, escape } from "@markox/html";

/**
 * Renders a `@markox/html` `.mx` fixture the same way
 * `packages/mx-html/src/fixtures.test.ts`'s own `render()` does: the emitted
 * TypeScript is stripped of imports/type annotations (its only TS) and run
 * with `new Function`, with `escape` and any imported `.mx` component passed
 * in as parameters. Kept as its own copy here rather than imported from the
 * test file, since test files aren't meant to be library entry points.
 */
export function renderMxHtml(
  dir: string,
  source: string,
  input: unknown,
): string {
  const { code } = compile(source, join(dir, "input.mx"));

  const componentNames: string[] = [];
  const componentFns: Array<(props: Record<string, unknown>) => string> = [];

  const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+\.mx)"$/gm;
  for (const match of code.matchAll(importRe)) {
    const [, name, relative] = match as unknown as [string, string, string];
    const componentSource = readFileSync(join(dir, relative), "utf8");
    componentNames.push(name);
    componentFns.push((props) => renderMxHtml(dir, componentSource, props));
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
