import { readFileSync } from "node:fs";

export interface DivergenceEntry {
  fixture: string;
  variant: string;
  reason: string;
}

/**
 * Parses fixtures/divergences.md as a markdown table with columns
 * `fixture | variant | reason`. Header and separator rows are skipped.
 */
export function parseDivergences(path: string): DivergenceEntry[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().startsWith("|"));

  const rows: DivergenceEntry[] = [];
  for (const line of lines) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const fixture = cells[0];
    const variant = cells[1];
    const reason = cells[2];
    if (!fixture || !variant || reason === undefined) continue;
    if (fixture.toLowerCase() === "fixture") continue;
    if (/^-+$/.test(fixture)) continue;
    rows.push({ fixture, variant, reason });
  }

  return rows;
}

export function findDivergence(
  entries: DivergenceEntry[],
  fixture: string,
  variant: string,
): DivergenceEntry | undefined {
  return entries.find((e) => e.fixture === fixture && e.variant === variant);
}
