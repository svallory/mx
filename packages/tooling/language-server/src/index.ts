/**
 * `@mxlang/language-server` — diagnostics-only LSP server for MX hosts
 * (decision 71/72). See `README.md` for what it does and does not do.
 */

export { resolveHostPolicy } from "@mxlang/core";
export { diagnoseDocument, type HostPolicy } from "./diagnose.ts";
export { startServer } from "./server.ts";
