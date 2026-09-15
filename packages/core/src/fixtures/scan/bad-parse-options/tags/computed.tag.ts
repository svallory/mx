import type { CustomTag } from "../../../../custom-tags.ts";

const shared = { text: true };

/** Not readable without executing the module: the scan must say so. */
const computed: CustomTag = { parseOptions: shared };
export default computed;
