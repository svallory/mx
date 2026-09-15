import type { CustomTag } from "../../../../custom-tags.ts";

/** No `parseOptions` of its own: it inherits the directory-level default. */
const panel: CustomTag = { attributes: { title: { type: "string" } } };
export default panel;
