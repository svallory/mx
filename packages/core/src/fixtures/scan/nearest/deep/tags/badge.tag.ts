import type { CustomTag } from "../../../../../custom-tags.ts";

/** The nearer `tags/` directory: this one must win. */
const badge: CustomTag = { attributes: { nearest: { type: "string" } } };
export default badge;
