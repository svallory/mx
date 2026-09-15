/**
 * Discovered by the language server from the document's own path. The server
 * receives a `file://` URI, so this file is only reachable if that URI is
 * converted to a path before the scan walks upward.
 */
export default {
  transform: (
    _call: unknown,
    ctx: { build: { text(value: string): unknown } },
  ) => [ctx.build.text("stamped")],
};
