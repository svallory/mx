import {
  type Attr,
  type AttributeTag,
  drive,
  type Emitter,
  type Expr,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type Position,
  TranslateError,
} from "@mxlang/core";

const STATEFUL_ERRORS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is Marko reactive state; use Solid's `createSignal` in the surrounding TypeScript module",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a Marko reactive effect; use Solid's `createEffect` in the surrounding TypeScript module",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a Marko lifecycle hook; use Solid's lifecycle primitives in the surrounding TypeScript module",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` is a Marko client-runtime tag; write client code in the surrounding TypeScript module",
  },
};

type TryData = { kind: "try" };

function positionOf(node: { loc: Position }): Position {
  return node.loc;
}

function fail(message: string, node: { loc: Position }): never {
  const { line, column } = positionOf(node);
  throw new TranslateError(message, line, column);
}

function rawPosition(node: { loc?: { start?: Position } }): Position {
  return node.loc?.start ?? { line: 0, column: 0 };
}

function rawFail(message: string, node: { loc?: { start?: Position } }): never {
  const { line, column } = rawPosition(node);
  throw new TranslateError(message, line, column);
}

/** Resolve-time questions for Solid's JSX target. */
export const solidDeclarations: HostDeclarations = {
  tags: STATEFUL_ERRORS,
  isElement: (name) => !/^[A-Z]/.test(name),
  isComponent: (name) => /^[A-Z]/.test(name),
  claimsTag: (name) => name === "try",
  resolveHostTag(name, node): TryData {
    if (name !== "try") rawFail(`unknown Solid host tag ${name}`, node);
    if (node.body?.params?.length) {
      rawFail("tag params (`|a, b|`) on `<try>`", node);
    }
    if (node.var) rawFail("tag variable (`/name`) on `<try>`", node);
    if (node.arguments) rawFail("tag arguments `(...)` on `<try>`", node);
    if ((node.attributes ?? []).length > 0) {
      rawFail("attributes on `<try>` are not supported", node.attributes[0]);
    }

    const seen = new Set<string>();
    for (const tag of node.attributeTags ?? []) {
      const tagName = String(tag.name?.value ?? "").replace(/^@/, "");
      if (tagName !== "catch" && tagName !== "placeholder") {
        rawFail(`attribute tag \`<@${tagName}>\` inside \`<try>\``, tag);
      }
      if (seen.has(tagName)) {
        rawFail(
          `attribute tag \`@${tagName}\` given twice (repeatable attribute tags are not supported)`,
          tag,
        );
      }
      seen.add(tagName);
      if ((tag.attributes ?? []).length > 0) {
        rawFail(
          "attribute tags take params or a body, not attributes (v1)",
          tag,
        );
      }
      if (tagName === "placeholder" && tag.body?.params?.length) {
        rawFail("tag params (`|a, b|`) on `<@placeholder>`", tag);
      }
    }
    return { kind: "try" };
  },
  resolveModifier(attr) {
    if ((attr.default && attr.name === "value") || attr.name.includes(":")) {
      rawFail("malformed namespaced attribute", attr);
    }
    if (attr.name === "prop" && attr.modifier) {
      return `prop:${attr.modifier}`;
    }
    return undefined;
  },
  rejectModifier(attr) {
    const replacements: Record<string, string> = {
      on: "`on:x=fn` was removed in Solid 2; use `onX=fn` for a delegated event, or a `ref` callback calling `addEventListener` for listener options",
      oncapture:
        "`oncapture:x=fn` was removed in Solid 2; use a `ref` callback calling `addEventListener(..., { capture: true })`",
      attr: "`attr:x=v` was removed in Solid 2; use the plain attribute `x=v`",
      bool: "`bool:x=v` was removed in Solid 2; use the plain attribute `x=v`",
      use: "`use:foo=opts` was removed in Solid 2; use `ref=foo(opts)` (a directive is now a function returning a ref callback)",
    };
    rawFail(
      replacements[attr.name] ??
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported by Solid`,
      attr,
    );
  },
  resolveAttributeMethod: () => true,
};

function escapeText(value: string): string {
  return value.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function numericValue(expr: Expr): number | null {
  const node = expr.node;
  if (node?.type === "NumericLiteral" && typeof node.value === "number") {
    return node.value;
  }
  if (node?.type === "UnaryExpression" && node.operator === "-") {
    const argument = node.argument;
    if (
      argument?.type === "NumericLiteral" &&
      typeof argument.value === "number"
    ) {
      return -argument.value;
    }
  }
  return null;
}

function staticTemplateValue(expr: Expr): string | null {
  const node = expr.node;
  if (node?.type !== "TemplateLiteral") return null;
  const expressions = node.expressions ?? [];
  if (
    expressions.some(
      (item: { type?: string }) => item?.type !== "StringLiteral",
    )
  ) {
    return null;
  }
  let value = "";
  for (let index = 0; index < (node.quasis ?? []).length; index++) {
    value += node.quasis[index]?.value?.cooked ?? "";
    value += expressions[index]?.value ?? "";
  }
  return value;
}

function methodExpression(expr: Expr): string | null {
  if (expr.node?.type !== "FunctionExpression") return null;
  const match = expr.code.match(
    /^(async\s+)?function\s*\(([\s\S]*)\)\s*(\{[\s\S]*\})$/,
  );
  if (!match) return expr.code;
  return `${match[1] ?? ""}(${match[2] ?? ""}) => ${match[3] ?? "{}"}`;
}

function renderAttr(attr: Attr): string {
  switch (attr.kind) {
    case "spread":
      return ` {...${attr.value.code}}`;
    case "boolean":
      return ` ${attr.name}={true}`;
    case "static":
      return ` ${attr.name}="${escapeAttribute(attr.value)}"`;
    case "bound":
      return fail(
        "bound attribute (`:=`) is Marko reactive state; use Solid state and an explicit event handler",
        attr,
      );
    case "dynamic": {
      if (attr.name === "style" && attr.value.shape !== "object") {
        return fail("`style=` with a non-object value", attr);
      }
      const fixed =
        attr.name === "class" ? staticTemplateValue(attr.value) : null;
      if (fixed !== null) {
        return ` ${attr.name}="${escapeAttribute(fixed)}"`;
      }
      return ` ${attr.name}={${methodExpression(attr.value) ?? attr.value.code}}`;
    }
  }
}

function renderAttrs(attrs: Attr[]): string {
  const ids = attrs.filter(
    (attr) => attr.kind !== "spread" && attr.name === "id",
  );
  if (ids.length > 1 && ids.some((attr) => attr.loc.line === 0)) {
    fail(
      "`#id` shorthand combined with an explicit `id=` attribute",
      ids[0] as Attr,
    );
  }

  const classEntries = attrs
    .map((attr, index) => ({ attr, index }))
    .filter(({ attr }) => attr.kind !== "spread" && attr.name === "class");
  const invalidShorthandMerge = classEntries.find(({ attr }) => {
    if (attr.kind !== "dynamic" || attr.value.shape !== "array") return false;
    const array = attr.value.node;
    // Marko folds `.card class=value` into a synthetic array whose own `loc`
    // is absent. Solid accepts that fold only when the explicit value is an
    // object literal; a real authored array has a location and remains valid.
    return (
      !array.loc &&
      array.elements?.[0]?.type === "StringLiteral" &&
      array.elements?.[1]?.type !== "ObjectExpression"
    );
  });
  if (invalidShorthandMerge) {
    fail(
      "`.class` shorthand combined with a non-string `class={...}` value (combine shorthand with a string class or use class={...})",
      invalidShorthandMerge.attr,
    );
  }
  const structured = classEntries.find(
    ({ attr }) =>
      attr.kind === "dynamic" &&
      (attr.value.shape === "object" || attr.value.shape === "array"),
  );
  if (!structured) {
    if (
      classEntries.length > 1 &&
      classEntries.some(
        ({ attr }) =>
          attr.kind === "dynamic" && staticTemplateValue(attr.value) === null,
      )
    ) {
      fail(
        "`.class` shorthand combined with a non-string `class={...}` value (combine shorthand with a string class or use class={...})",
        classEntries.at(-1)?.attr as Attr,
      );
    }
    return attrs.map(renderAttr).join("");
  }

  const strings = classEntries.flatMap(({ attr }) => {
    if (attr.kind === "static") return [attr.value];
    if (attr.kind !== "dynamic") return [];
    const value = staticTemplateValue(attr.value);
    return value === null ? [] : [value];
  });
  const merged = strings.join(" ");
  return attrs
    .map((attr, index) => {
      if (
        attr.kind !== "spread" &&
        attr.name === "class" &&
        index !== structured.index
      ) {
        return "";
      }
      if (index !== structured.index || attr.kind !== "dynamic") {
        return renderAttr(attr);
      }
      if (merged === "") return renderAttr(attr);
      if (attr.value.shape === "array") {
        return ` class={[${JSON.stringify(merged)}, ...${attr.value.code}]}`;
      }
      return ` class={[${JSON.stringify(merged)}, ${attr.value.code}]}`;
    })
    .join("");
}

function meaningful(nodes: IrNode[]): IrNode[] {
  return nodes.filter(
    (node) =>
      node.kind !== "Comment" && !(node.kind === "Text" && node.value === ""),
  );
}

function rawChild(
  nodes: IrNode[],
): Extract<IrNode, { kind: "Interpolation" }> | null {
  const content = meaningful(nodes);
  if (content.length !== 1) return null;
  const only = content[0];
  return only?.kind === "Interpolation" && !only.escaped ? only : null;
}

function rejectMixedRaw(nodes: IrNode[]): void {
  const content = meaningful(nodes);
  const raw = content.find(
    (node): node is Extract<IrNode, { kind: "Interpolation" }> =>
      node.kind === "Interpolation" && !node.escaped,
  );
  if (raw && content.length !== 1) {
    fail("raw placeholder must be the only child", raw);
  }
}

function hasNamedAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => attr.kind !== "spread" && attr.name === name);
}

function renderWithNewEmitter(nodes: IrNode[]): string {
  const child = new SolidEmitter();
  drive(child, nodes);
  return child.done();
}

function blockExpression(nodes: IrNode[]): string {
  const content = meaningful(nodes);
  if (content.length === 1) {
    const only = content[0] as IrNode;
    if (only.kind === "Interpolation" && only.escaped) return only.expr.code;
    if (
      only.kind === "Element" ||
      only.kind === "Component" ||
      only.kind === "IfChain" ||
      only.kind === "For" ||
      only.kind === "HostTag"
    ) {
      return renderWithNewEmitter(content);
    }
  }
  return `<>${renderWithNewEmitter(content)}</>`;
}

function attributeTag(tag: AttributeTag): string {
  const value = blockExpression(tag.block.children);
  if (!tag.block.hasParams) return ` ${tag.name}={${value}}`;
  return ` ${tag.name}={(${tag.block.params.join(", ")}) => ${value}}`;
}

function identifierNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

function hygienicIndex(params: string[], body: string): string {
  const used = identifierNames(`${params.join(" ")} ${body}`);
  if (!used.has("mxIndex")) return "mxIndex";
  let index = 2;
  while (used.has(`mxIndex${index}`)) index++;
  return `mxIndex${index}`;
}

/** Solid JSX text emitter over the shared core IR. */
export class SolidEmitter implements Emitter<string> {
  readonly #out: string[] = [];

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    this.#out.push(escapeText(node.value));
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (!node.escaped) fail("raw placeholder must be the only child", node);
    this.#out.push(`{${node.expr.code}}`);
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    const raw = rawChild(node.children);
    rejectMixedRaw(node.children);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }
    const attrs = renderAttrs(node.attrs);
    const innerHtml = raw ? ` innerHTML={${raw.expr.code}}` : "";
    if (node.void) {
      this.#out.push(`<${node.name}${attrs}${innerHtml} />`);
      return;
    }
    const children = raw ? "" : renderWithNewEmitter(node.children);
    this.#out.push(
      `<${node.name}${attrs}${innerHtml}>${children}</${node.name}>`,
    );
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    if (node.target.kind === "dynamic") {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX syntax, not interpolation
      fail("dynamic tag name (`<${...}>`)", node);
    }
    const name = node.target.name;
    const contentNodes = node.content?.children ?? [];
    const raw = node.content ? rawChild(contentNodes) : null;
    rejectMixedRaw(contentNodes);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }

    const attrs = renderAttrs(node.attrs);
    const tags = node.attributeTags.map(attributeTag).join("");
    const innerHtml = raw ? ` innerHTML={${raw.expr.code}}` : "";
    if (!node.content || raw) {
      this.#out.push(`<${name}${attrs}${tags}${innerHtml} />`);
      return;
    }

    const body = blockExpression(contentNodes);
    const children = node.content.hasParams
      ? `{(${node.content.params.join(", ")}) => ${body}}`
      : renderWithNewEmitter(contentNodes);
    this.#out.push(`<${name}${attrs}${tags}>${children}</${name}>`);
  }

  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    const conditioned = node.branches.filter((branch) => branch.condition);
    const fallback = node.branches.find((branch) => !branch.condition);
    const renderShow = (
      index: number,
      finalFallback: string | null,
    ): string => {
      const branch = conditioned[index];
      if (!branch?.condition) return finalFallback ?? "<></>";
      const next =
        index + 1 < conditioned.length
          ? renderShow(index + 1, finalFallback)
          : finalFallback;
      const fallbackAttr = next === null ? "" : ` fallback={${next}}`;
      return `<Show when={${branch.condition.code}}${fallbackAttr}>${blockExpression(branch.children)}</Show>`;
    };
    const fallbackCode = fallback ? blockExpression(fallback.children) : null;
    if (conditioned.length <= 2) {
      this.#out.push(renderShow(0, fallbackCode));
      return;
    }
    const fallbackAttr = fallbackCode ? ` fallback={${fallbackCode}}` : "";
    const matches = conditioned
      .map(
        (branch) =>
          `<Match when={${branch.condition?.code}}>${blockExpression(branch.children)}</Match>`,
      )
      .join("");
    this.#out.push(`<Switch${fallbackAttr}>${matches}</Switch>`);
  }

  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    const body = blockExpression(node.children);
    const [first = "item", second] = node.params;
    if (node.source.kind === "of") {
      let keyed: string;
      if (!node.key) keyed = " keyed={false}";
      else if (node.key.shape === "string") {
        const field =
          node.key.node?.type === "StringLiteral"
            ? node.key.node.value
            : node.key.code.replace(/^['"]|['"]$/g, "");
        keyed = ` keyed={x => x.${field}}`;
      } else if (node.key.code.trim() === "identity") keyed = "";
      else keyed = ` keyed={${node.key.code}}`;
      this.#out.push(
        `<For each={${node.source.list.code}}${keyed}>{(${node.params.join(", ")}) => ${body}}</For>`,
      );
      return;
    }
    if (node.source.kind === "in") {
      this.#out.push(
        `<For each={Object.entries(${node.source.object.code})} keyed={e => e[0]}>{([${first}, ${second ?? "value"}]) => ${body}}</For>`,
      );
      return;
    }

    const from = node.source.from?.code ?? "0";
    const bound = node.source.bound.code;
    const fromValue = node.source.from ? numericValue(node.source.from) : 0;
    const boundValue = numericValue(node.source.bound);
    const step = node.source.step;
    if (!step) {
      const count =
        fromValue !== null && boundValue !== null
          ? String(
              node.source.inclusive
                ? boundValue - fromValue + 1
                : boundValue - fromValue,
            )
          : node.source.inclusive
            ? `(${bound}) - (${from}) + 1`
            : `(${bound}) - (${from})`;
      const fromAttr = node.source.from ? ` from={${from}}` : "";
      this.#out.push(
        `<Repeat count={${count}}${fromAttr}>{(${node.params.join(", ")}) => ${body}}</Repeat>`,
      );
      return;
    }

    const stepValue = numericValue(step);
    if (stepValue === 0) {
      rawFail("`<for step=...>`: step must not be 0", step.node);
    }
    let count: string;
    if (fromValue !== null && boundValue !== null && stepValue !== null) {
      const ratio = (boundValue - fromValue) / stepValue;
      count = String(
        Math.max(
          0,
          node.source.inclusive ? Math.floor(ratio) + 1 : Math.ceil(ratio),
        ),
      );
    } else {
      const rounded = `${node.source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${node.source.inclusive ? " + 1" : ""}`;
      count = `Number.isFinite(${rounded}) ? Math.max(0, ${rounded}) : 0`;
    }
    const counter = hygienicIndex(node.params, body);
    this.#out.push(
      `<Repeat count={${count}}>{(${counter}) => { const ${first} = (${from}) + ${counter} * (${step.code}); return ${body}; }}</Repeat>`,
    );
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    fail(
      "`<define>` cannot declare a function inside a JSX expression; declare it in the surrounding TypeScript module",
      node,
    );
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    fail(
      "`<const>` cannot declare a binding inside a JSX expression; declare it in the surrounding TypeScript module",
      node,
    );
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail("a hoisted statement cannot be emitted inside a JSX expression", node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const data = node.tag.data as TryData;
    if (data.kind !== "try") fail("unknown Solid host-tag lowering", node);
    const catchTag = node.tag.attributeTags.find((tag) => tag.name === "catch");
    const placeholder = node.tag.attributeTags.find(
      (tag) => tag.name === "placeholder",
    );
    const fallback = placeholder
      ? ` fallback={${blockExpression(placeholder.block.children)}}`
      : "";
    const loading = `<Loading${fallback}>${renderWithNewEmitter(node.tag.children)}</Loading>`;
    if (!catchTag) {
      this.#out.push(loading);
      return;
    }
    const params = catchTag.block.params.join(", ");
    const caught = blockExpression(catchTag.block.children);
    this.#out.push(
      `<Errored fallback={(${params}) => ${caught}}>${loading}</Errored>`,
    );
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    fail("a document type cannot appear inside a JSX expression", node);
  }

  comment(_node: Extract<IrNode, { kind: "Comment" }>): void {}

  done(): string {
    return this.#out.join("");
  }
}

export function createEmitter(): SolidEmitter {
  return new SolidEmitter();
}

export function emitSolid(ir: Ir): string {
  const emitter = createEmitter();
  drive(emitter, ir.body);
  return emitter.done();
}
