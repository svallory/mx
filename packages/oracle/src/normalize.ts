/**
 * Normalize generated code for byte-parity comparison. Collapses whitespace
 * runs outside string/template literals and comments to one space, trims
 * line ends, and unifies line endings. Nothing else changes: no reordering,
 * no renaming. Comment spans (// and /* *\/) are skipped whole so a quote
 * inside a comment never starts string-literal state. See fixtures/README.md
 * for the full contract.
 */
export function normalize(code: string): string {
  const unified = code.replace(/\r\n/g, "\n");
  let out = "";
  let i = 0;
  const n = unified.length;

  while (i < n) {
    const ch = unified[i];

    if (ch === "/" && unified[i + 1] === "/") {
      const start = i;
      while (i < n && unified[i] !== "\n") i++;
      out += unified.slice(start, i);
      continue;
    }

    if (ch === "/" && unified[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(unified[i] === "*" && unified[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += unified.slice(start, i);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        if (unified[i] === "\\") {
          i += 2;
          continue;
        }
        if (unified[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += unified.slice(start, i);
      continue;
    }

    if (ch === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < n) {
        if (unified[i] === "\\") {
          i += 2;
          continue;
        }
        if (unified[i] === "`" && depth === 0) {
          i++;
          break;
        }
        if (unified[i] === "$" && unified[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (unified[i] === "}" && depth > 0) {
          depth--;
          i++;
          continue;
        }
        i++;
      }
      out += unified.slice(start, i);
      continue;
    }

    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (unified[j] === " " || unified[j] === "\t")) j++;
      out += " ";
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}
