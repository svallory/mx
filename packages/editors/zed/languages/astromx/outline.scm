; Vendored verbatim from marko-js/zed languages/marko/outline.scm, via languages/mx/outline.scm
; AstroMX (.amx) rides Marko's grammar: the template half of an .amx file is MX,
; a strict Marko subset (decision 72), so Marko's own queries apply unchanged.
; Source: https://github.com/marko-js/zed, snapshot dd854edec1fab86d23eb24af9691505dfe3856a6
; No overlay, no edits (decision 72). Grammar pin: marko-js/tree-sitter @ 7fb20382b9b0c97c8bdbceee0e0641bea11dd00f

; Outline entries, in Zed's outline.scm @item/@name convention (other
; tools ignore this file). Every element appears, labeled with its tag
; name and #id/.class shorthands. Statement tags (import/export/static/…)
; are statements rather than document structure, so they are excluded.

((element
   (tag_name) @name
   [(shorthand_id) (shorthand_class)]* @name) @item
 (#not-any-of? @name "import" "export" "class" "static" "server" "client"))
