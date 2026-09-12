/**
 * The MX → Astro-template emitter (decisions 76c, 78 and 79).
 *
 * An `.amx` file keeps Astro's TypeScript frontmatter byte-for-byte and uses
 * MX for the template that follows it. The core parses that template,
 * resolves Marko nodes into its host-independent IR, and drives the emitter in
 * this file. No emission path here inspects a Marko node.
 */

import {
  type Attr,
  DYNAMIC_TAG,
  drive,
  type Emitter,
  emit,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type Node,
  newCtx,
  parseFragment,
  resolve,
  TranslateError,
} from "@mxlang/core";

/** A lowering failure positioned in the enclosing `.amx` file. */
export class AstroTemplateError extends Error {
  line: number;
  column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AstroTemplateError";
    this.line = line;
    this.column = column;
  }
}

type Positioned = { loc: { line: number; column: number } };

function fail(message: string, node: Positioned | Node): never {
  const start = node?.loc?.start ?? node?.loc ?? { line: 0, column: 0 };
  throw new AstroTemplateError(message, start.line ?? 0, start.column ?? 0);
}

const TAGS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is reactive state and requires a runtime; `.amx` renders static markup at build time",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a reactive effect and requires a runtime; `.amx` renders static markup at build time",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; `.amx` renders static markup at build time",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` as a Marko tag runs client code and requires a runtime; `.amx` renders static markup at build time",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is client-only and requires a runtime; `.amx` renders static markup at build time",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for the reactive runtime; `.amx` renders static markup at build time",
  },
  await: {
    kind: "error",
    reason:
      "`<await>` needs a suspense-capable renderer; `.amx` renders static markup at build time",
  },
  return: {
    kind: "error",
    reason:
      "`<return>` hands a value to a parent template; an Astro component has no parent template to return to",
  },
  const: {
    kind: "error",
    reason:
      "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
  },
  define: {
    kind: "error",
    reason:
      "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it",
  },
  try: {
    kind: "error",
    reason:
      "`<try>` needs an error boundary; Astro renders components statically at build time and has no equivalent",
  },
  else: { kind: "error", reason: "`<else>` must follow an `<if>`" },
  "else-if": { kind: "error", reason: "`<else-if>` must follow an `<if>`" },
};

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

type HostTagData = { kind: "interpolation"; code: string };

/** Questions the Astro host answers while Marko nodes are still available. */
const declarations: HostDeclarations = {
  tags: TAGS,
  isElement: (name) => !isComponentName(name),
  isComponent: (name) => isComponentName(name),
  keepComments: true,
  orderAttrs: (name, attrs) => {
    if (name !== "input") return attrs;
    const index = attrs.findIndex(
      (attr) => attr.kind !== "spread" && attr.name === "value",
    );
    if (index <= 0) return attrs;
    const value = attrs[index] as Attr;
    return [value, ...attrs.slice(0, index), ...attrs.slice(index + 1)];
  },
  claimsTag: (name) => name === DYNAMIC_TAG,
  resolveHostTag: (name, node, ctx): HostTagData => {
    if (name !== DYNAMIC_TAG) {
      fail(`unknown Astro host tag ${JSON.stringify(name)}`, node);
    }

    // A bare top-level `${expr}` is Marko's expression-named tag shape. It is
    // still an interpolation; a dynamic tag has attributes or a body and is a
    // host-specific error. The decision is recorded in `data`, so emission
    // never re-inspects the Marko node.
    if ((node.attributes ?? []).length === 0 && !node.body?.body?.length) {
      return { kind: "interpolation", code: ctx.generate(node.name) };
    }
    fail(
      "a dynamic tag name (`<${expr}>`) is not supported in an `.amx` template; Astro resolves component names statically",
      node,
    );
  },
  rejectModifier: (attr) => {
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in an \`.amx\` template`,
      attr,
    );
  },
  rejectAttributeMethod: (attr) => {
    fail(
      `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; \`.amx\` renders static markup at build time`,
      attr,
    );
  },
  rejectElementAttributeTags: (name, node) => {
    const first = node.attributeTags?.[0];
    const slot = String(first?.name?.value ?? "").replace(/^@/, "");
    fail(
      `attribute tags (\`<@${slot}>\`) lower to Astro named slots, which only a component accepts; \`<${name}>\` is an HTML element`,
      first ?? node,
    );
  },
  rejectComponentTag: (name, node) => {
    if ((node.body?.params ?? []).length === 0) return;
    fail(
      `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
      node,
    );
  },
};

function escapeText(text: string): string {
  return text.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderChildren(nodes: IrNode[]): string {
  const emitter = createEmitter();
  drive(emitter, nodes);
  return emitter.done();
}

function fragment(nodes: IrNode[]): string {
  return `<Fragment>${renderChildren(nodes)}</Fragment>`;
}

function attrsOf(attrs: Attr[]): string {
  const rendered = attrs.map((attr) => {
    switch (attr.kind) {
      case "spread":
        return ` {...${attr.value.code}}`;
      case "boolean":
        return ` ${attr.name}`;
      case "static":
        return ` ${attr.name}="${escapeAttr(attr.value)}"`;
      case "bound":
        return fail(
          "`:=` is a two-way binding and requires a reactive runtime; `.amx` renders static markup at build time",
          attr,
        );
      case "dynamic": {
        const structuredClass =
          attr.name === "class" &&
          (attr.value.shape === "object" || attr.value.shape === "array");
        return structuredClass
          ? ` class:list={${attr.value.code}}`
          : ` ${attr.name}={${attr.value.code}}`;
      }
    }
    throw new Error("unreachable attribute kind");
  });

  return rendered.join("");
}

/** Creates one Astro-template emitter over core's IR. */
export function createEmitter(): Emitter<string> {
  const out: string[] = [];

  const emitter: Emitter<string> = {
    text(node) {
      out.push(escapeText(node.value));
    },

    interpolation(node) {
      out.push(
        node.escaped
          ? `{${node.expr.code}}`
          : `<Fragment set:html={${node.expr.code}} />`,
      );
    },

    element(node) {
      const attrs = attrsOf(node.attrs);
      if (node.void) {
        out.push(`<${node.name}${attrs} />`);
        return;
      }
      out.push(`<${node.name}${attrs}>`);
      drive(emitter, node.children);
      out.push(`</${node.name}>`);
    },

    component(node) {
      if (node.target.kind !== "name") {
        fail(
          node.target.kind === "define"
            ? "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it"
            : "a dynamic tag name (`<${expr}>`) is not supported in an `.amx` template; Astro resolves component names statically",
          node,
        );
      }

      const name = node.target.name;
      if (node.content?.params.length) {
        fail(
          `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
          node,
        );
      }
      const attrs = attrsOf(node.attrs);
      const hasChildren =
        Boolean(node.content) || node.attributeTags.length > 0;
      if (!hasChildren) {
        out.push(`<${name}${attrs} />`);
        return;
      }

      out.push(`<${name}${attrs}>`);
      if (node.content) drive(emitter, node.content.children);
      for (const tag of node.attributeTags) {
        if (tag.block.params.length > 0) {
          fail(
            `\`<@${tag.name}>\` declares tag params, which lower to a render prop; Astro slots carry markup, not functions`,
            tag,
          );
        }
        out.push(`<Fragment slot="${escapeAttr(tag.name)}">`);
        drive(emitter, tag.block.children);
        out.push("</Fragment>");
      }
      out.push(`</${name}>`);
    },

    ifChain(node) {
      const branches = node.branches.map((branch) =>
        branch.condition
          ? `${branch.condition.code} ? (${fragment(branch.children)})`
          : `(${fragment(branch.children)})`,
      );
      if (node.branches.at(-1)?.condition) branches.push("null");
      out.push(`{${branches.join(" : ")}}`);
    },

    forLoop(node) {
      if (node.source.kind === "range" && node.source.step) {
        fail(
          "`<for step=...>`: step is not supported; use a computed array",
          node,
        );
      }
      const [first, second] = node.params;
      const branch = fragment(node.children);
      if (node.source.kind === "of") {
        const args = second ? `${first}, ${second}` : first;
        out.push(
          `{[...${node.source.list.code}].map((${args}) => (${branch}))}`,
        );
        return;
      }
      if (node.source.kind === "in") {
        out.push(
          `{Object.entries(${node.source.object.code}).map(([${first}, ${second ?? "value"}]) => (${branch}))}`,
        );
        return;
      }

      const start = node.source.from?.code ?? "0";
      const bound = node.source.bound.code;
      const length = node.source.inclusive
        ? `(${bound}) - (${start}) + 1`
        : `(${bound}) - (${start})`;
      out.push(
        `{Array.from({ length: Math.max(0, ${length}) }, (_, $i) => (${start}) + $i).map((${first}) => (${branch}))}`,
      );
    },

    define(node) {
      fail(
        "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it",
        node,
      );
    },

    constant(node) {
      fail(
        "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
        node,
      );
    },

    hoisted(node) {
      fail(
        "a statement hoisted inside an Astro template block cannot be represented in frontmatter without changing its scope",
        node,
      );
    },

    hostTag(node) {
      const data = node.tag.data as HostTagData;
      if (data.kind !== "interpolation") {
        fail("unknown Astro host-tag lowering", node);
      }
      out.push(`{${data.code}}`);
    },

    documentType(node) {
      out.push(`<!${node.value}>`);
    },

    comment(node) {
      out.push(`<!--${node.value}-->`);
    },

    done() {
      return out.join("");
    },
  };

  return emitter;
}

/** Emits the template half of a resolved `.amx` file. */
export function emitTemplate(ir: Ir): string {
  return emit(createEmitter(), ir);
}

export interface LowerResult {
  code: string;
}

function addHoistedToFence(fence: string, statements: string[]): string {
  if (statements.length === 0) return fence;
  const newline = fence.includes("\r\n") ? "\r\n" : "\n";
  if (fence === "") {
    return `---${newline}${statements.join(newline)}${newline}---${newline}`;
  }

  const close = fence.lastIndexOf(`${newline}---`);
  if (close < 0) return fence;
  return `${fence.slice(0, close)}${newline}${statements.join(newline)}${fence.slice(close)}`;
}

/** Splits an `.amx` file, resolves its MX template, and emits Astro syntax. */
export function lowerAstroMx(source: string, filename: string): LowerResult {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/);
  const originalFence = match ? match[0] : "";
  const template = match ? source.slice(originalFence.length) : source;
  const baseOffset = originalFence.length;
  const baseLine = originalFence ? originalFence.split("\n").length - 1 : 0;

  const { body } = parseFragment(template, {
    filename,
    baseOffset,
    baseLine,
    baseColumn: 0,
  });

  try {
    const ctx = newCtx(source, (node) => sourceOf(source, node), declarations);
    const ir = resolve(ctx, body);
    const statements = [
      ...ir.imports,
      ...ir.hoisted,
      ...(ir.inputInterface ? [ir.inputInterface] : []),
      ...ir.prelude,
    ];
    return {
      code: `${addHoistedToFence(originalFence, statements)}${emitTemplate(ir)}`,
    };
  } catch (error) {
    if (error instanceof AstroTemplateError) throw error;
    if (error instanceof TranslateError) {
      throw new AstroTemplateError(error.message, error.line, error.column);
    }
    throw error;
  }
}

/** Prints an expression by slicing its file-relative source range. */
function sourceOf(source: string, node: Node): string {
  const start = node?.loc?.start?.index;
  const end = node?.loc?.end?.index;
  if (typeof start === "number" && typeof end === "number") {
    return source.slice(start, end);
  }
  fail("expression has no source position", node);
}
