import type { CustomTag } from "../../../../custom-tags.ts";

/** Overrides the directory default, which is the documented precedence. */
const override: CustomTag = { parseOptions: { text: false } };
export default override;
