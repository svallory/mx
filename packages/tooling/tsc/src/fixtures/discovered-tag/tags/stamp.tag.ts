/**
 * Discovered by `mx-tsc` with no import from the calling template, and with
 * no `customTags` option anywhere: `mx-tsc` builds the language plugin with
 * none, so this file is reachable only through the scan.
 */
export default {
  transform: (
    _call: unknown,
    ctx: { build: { text(value: string): unknown } },
  ) => [ctx.build.text("stamped")],
};
