import type {
  CustomTag,
  IrNode,
  TagCall,
  TransformContext,
} from "@mxlang/core";

/**
 * Declares `parseOptions.text`, so its body arrives as one unparsed run.
 *
 * This is the acceptance case for reading `parseOptions` before the *caller*
 * is parsed: the body below contains `<` and `#`, which Marko would otherwise
 * try to read as a tag and a shorthand id. A caller that never imports this
 * file still gets the right parse, which is only possible if the scan read
 * this declaration without executing the module.
 */
function transform(call: TagCall, ctx: TransformContext): IrNode[] {
  const body = call.content?.children ?? [];
  const text = body
    .map((node) => (node.kind === "Text" ? node.value : ""))
    .join("");
  return [ctx.build.element("pre", [], [ctx.build.text(text)])];
}

const snippet: CustomTag = {
  parseOptions: { text: true },
  transform,
};

export default snippet;
