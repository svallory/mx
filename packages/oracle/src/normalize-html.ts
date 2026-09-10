/**
 * Minimal HTML-aware normalization for the `oracle:marko` parity check —
 * comparing two real HTML strings, not generated JS. Kept deliberately
 * small: only differences the two renderers are expected to produce
 * legitimately (not meaningfully) are collapsed. See fixtures/README.md's
 * "Marko column semantics" for the contract this exists under.
 *
 * - Whitespace runs between `>` and `<` are collapsed to nothing: neither
 *   renderer is expected to preserve template-source indentation as
 *   inter-tag whitespace.
 * - Self-closing void elements are unified to the non-self-closing spelling
 *   (`<br/>` -> `<br>`), since both are valid HTML and the two toolchains
 *   are free to pick either.
 * - An unquoted or single-quoted attribute value is requoted to double
 *   quotes (Marko picks whichever quoting needs no escaping for the value;
 *   mx-html always double-quotes and escapes). Both spellings are the same
 *   attribute value in HTML, so this is not a real difference; a `"` inside
 *   a requoted single-quoted value is escaped to `&quot;` to keep the result
 *   valid HTML.
 * - `&#34;` is unified to `&quot;` (Marko's numeric-entity spelling of the
 *   same character mx-html names) — same value, different spelling.
 * - Attribute order within a tag is preserved (not sorted) — a real
 *   attribute-order difference is a divergence worth seeing, not noise.
 */
export function normalizeHtml(html: string): string {
  const collapsed = html.replace(/>\s+</g, "><").trim();
  const unifiedVoids = collapsed.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:\s+[^<>]*)?)\/>/gi,
    "<$1$2>",
  );
  const singleQuoted = unifiedVoids.replace(
    /(<[a-zA-Z][^<>]*?\s[a-zA-Z][\w-]*)='([^']*)'/g,
    (_m, prefix: string, value: string) =>
      `${prefix}="${value.replace(/"/g, "&quot;")}"`,
  );
  const unquoted = singleQuoted.replace(
    /(<[a-zA-Z][^<>]*?\s[a-zA-Z][\w-]*)=([^\s"'<>=]+)(?=[\s>])/g,
    '$1="$2"',
  );
  return unquoted.replace(/&#34;/g, "&quot;");
}
