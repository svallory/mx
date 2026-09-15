import type { CustomTag } from "../../../../custom-tags.ts";

/**
 * Declares `text`, so the body of a `<raw>` call arrives unparsed. The scan
 * must read this without evaluating the module, which is why the default
 * export is a plain object literal bound to one module-scope name.
 */
const raw: CustomTag = {
  parseOptions: { text: true, preserveWhitespace: true },
  transform: (call, ctx) => [ctx.build.text(String(call.content ? "body" : ""))],
};
export default raw;
