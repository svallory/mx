/**
 * Runs each `<try>`-as-a-custom-tag attempt and records exactly where it
 * breaks (decision 85, experiment `custom-tags-check`, item 3).
 *
 * Output is the evidence behind the report's `<try>` section: four attempts
 * across the six hosts, each row either compiling (and then being wrong in a
 * stated way) or failing with the exact message. Run with
 * `bun packages/oracle/fixtures-custom-tags/try/probe.ts`.
 *
 * The template deliberately uses `<try>`'s full shape — a body that throws and
 * a `<@catch|error|>` that renders instead — so an attempt that silently drops
 * the catch body is visible rather than merely suspected.
 */

import type { CustomTagDefinition } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { compile as compileHtml } from "@mxlang/html";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";
import { asComponent, asHoist, asHostTag, asMarkup } from "./try.tag.ts";

const source = [
  `import boundary from "./try.tag.ts"`,
  `<boundary>`,
  `  <p>${"${input.risky()}"}</p>`,
  `  <@catch|error|>`,
  `    <p class="error">${"${error.message}"}</p>`,
  `  </@catch>`,
  `</boundary>`,
  ``,
].join("\n");

const file = "/tmp/mx-try-probe/input.mx";

type Compile = (
  source: string,
  filename: string,
  tags: Record<string, CustomTagDefinition>,
) => string;

const hosts: Array<[string, Compile]> = [
  ["html", (s, f, customTags) => compileHtml(s, f, { customTags }).code],
  [
    "astro",
    (s, f, customTags) => compileHtml(s, f, { customTags, strict: true }).code,
  ],
  ["preact", (s, f, customTags) => compilePreactMx(s, f, { customTags }).code],
  ["react", (s, f, customTags) => compileReactMx(s, f, { customTags }).code],
  ["hono", (s, f, customTags) => compileHonoMx(s, f, { customTags }).code],
  [
    "solid",
    (s, _f, customTags) =>
      compileSolidMx(
        s
          .split("\n")
          .filter((line) => !line.startsWith("import boundary"))
          .join("\n"),
        { filename: "/tmp/mx-try-probe/input.solid.mx", customTags },
      ).code,
  ],
];

/** The name each host's own `<try>` lowering uses for its boundary. */
const boundaryNames: Record<string, string> = {
  html: "MxErrorBoundary",
  astro: "MxErrorBoundary",
  preact: "MxErrorBoundary",
  react: "MxErrorBoundary",
  hono: "ErrorBoundary",
  solid: "Errored",
};

const attempts: Array<[string, (host: string) => CustomTagDefinition]> = [
  ["1. as markup (<mx-try>)", () => asMarkup],
  [
    "2. as a component call",
    (host) => asComponent(boundaryNames[host] ?? "MxErrorBoundary"),
  ],
  ["3. as hoisted statements", () => asHoist],
  ["4. as a HostTag the host claims", () => asHostTag],
];

for (const [label, makeTag] of attempts) {
  console.log(`\n=== ${label} ===`);
  for (const [host, compile] of hosts) {
    let outcome: string;
    try {
      const code = compile(source, file, { boundary: makeTag(host) });
      // It compiled. Say what it actually produced, because "compiles" is not
      // "works" — the whole point of attempts 1 and 3.
      const hasCatch = /error\.message|catch/.test(code);
      const hasMxTry = /mx-try/.test(code);
      const boundary = boundaryNames[host] ?? "";
      const namesBoundary = boundary !== "" && code.includes(boundary);
      const notes: string[] = [];
      if (hasMxTry) notes.push("emits a literal <mx-try> element");
      if (!hasCatch) notes.push("the <@catch> body is DROPPED");
      if (namesBoundary) {
        notes.push(`names \`${boundary}\` with no import that binds it`);
      }
      if (/^\s*try\s*\{/m.test(code) && !/out \+=[\s\S]*?\n\s*\}/.test(code)) {
        notes.push("hoisted `try {` sits at the function head, empty");
      }
      outcome = `compiles — ${notes.length ? notes.join("; ") : "output looks plausible"}`;
    } catch (error) {
      outcome = `THROWS — ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`  ${host.padEnd(7)} ${outcome}`);
  }
}

// The two attempts whose *emitted code* is the evidence, printed in full so
// the report can quote them rather than paraphrase.
if (process.env.MX_SHOW_CODE) {
  console.log("\n=== attempt 2 (component) emitted by the html host ===");
  console.log(
    compileHtml(source, file, {
      customTags: { boundary: asComponent("MxErrorBoundary") },
    }).code,
  );
  console.log("\n=== attempt 3 (hoist) emitted by the html host ===");
  console.log(
    compileHtml(source, file, { customTags: { boundary: asHoist } }).code,
  );
}
