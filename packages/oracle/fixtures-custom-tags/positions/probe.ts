/**
 * Measures what the TypeScript plugin's mapping stage does with a template
 * that calls a custom tag (decision 85, experiment `custom-tags-check`).
 *
 * `mx-language.ts` resolves the source a *second* time to build its
 * `CodeMapping`s, with its own `newCtx` and no `customTags` map — so the
 * question is not whether positions are right, but whether the mapping stage
 * runs at all. Measured, not reasoned.
 */
import { compile } from "@mxlang/html";
import { createHtmlMappings } from "../../../tooling/typescript-plugin/src/mx-language.ts";
import icon from "../icon/icon.tag.ts";

const source = [
  `import icon from "./icon.tag.ts"`,
  `<p>${"${input.label}"}</p>`,
  `<icon name="check" size=16/>`,
  ``,
].join("\n");

const compiled = compile(source, "/tmp/probe/input.mx", {
  customTags: { icon },
});
console.log("--- emitted ---");
console.log(compiled.code);

console.log(
  "\n--- mapping stage (no customTags, as mx-language.ts calls it) ---",
);
try {
  const mappings = createHtmlMappings(
    source,
    "/tmp/probe/input.mx",
    compiled.code,
    false,
    undefined,
    compiled.mappings,
    process.env.MX_WITH_TAGS ? { icon } : undefined,
  );
  console.log(`mappings: ${mappings.length}`);
  for (const m of mappings) {
    const start = m.sourceOffsets[0] ?? 0;
    const len = m.lengths[0] ?? 0;
    console.log(
      `  source[${start}..${start + len}] = ${JSON.stringify(source.slice(start, start + len))}`,
    );
  }
} catch (error) {
  console.log(
    `THREW: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`,
  );
}
