/**
 * Minimal line-by-line diff of two normalized strings. Not a general LCS
 * diff: enough to show the first divergence and surrounding context, which
 * is all the oracle report needs.
 */
export function lineDiff(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const out: string[] = [];

  for (let i = 0; i < max; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === a) continue;
    if (e !== undefined) out.push(`- ${i + 1}: ${e}`);
    if (a !== undefined) out.push(`+ ${i + 1}: ${a}`);
  }

  return out.join("\n");
}
