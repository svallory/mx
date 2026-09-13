/**
 * Joins Marko's recursive structured `class` value for Hono's string prop.
 *
 * Identical logic to `@mxlang/preact/runtime`'s and `@mxlang/react/runtime`'s
 * `mxClass` — kept as its own copy rather than a shared import so this
 * package has no runtime dependency beyond `hono` itself.
 */
export function mxClass(value: unknown): string {
  const parts: string[] = [];
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || item === false) return;
    if (typeof item === "string") {
      if (item !== "") parts.push(item);
      return;
    }
    if (typeof item === "number") {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
      return;
    }
    if (typeof item === "object") {
      for (const [key, enabled] of Object.entries(item)) {
        if (enabled) parts.push(key);
      }
    }
  };
  walk(value);
  return parts.join(" ");
}
