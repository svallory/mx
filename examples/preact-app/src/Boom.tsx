/**
 * A component that throws on demand, for the `<try>` boundary to catch.
 *
 * `.tsx` rather than `.mx`: MX has no "throw here" construct, and inventing
 * one to make the example demonstrable would be testing a construct the
 * language does not have. What the example demonstrates is the `<try>`
 * *lowering* — that MX's `<@catch>` wires a real Preact boundary around a
 * real child.
 */
export function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("boom from a child");
  return <p data-testid="boom-ok">child rendered fine</p>;
}
