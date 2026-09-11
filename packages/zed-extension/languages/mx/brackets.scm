; Vendored verbatim from marko-js/zed languages/marko/brackets.scm
; Source: https://github.com/marko-js/zed, snapshot dd854edec1fab86d23eb24af9691505dfe3856a6
; No overlay, no edits (decision 72). Grammar pin: marko-js/tree-sitter @ 7fb20382b9b0c97c8bdbceee0e0641bea11dd00f

; Bracket pairs, in Zed's brackets.scm @open/@close convention (other
; tools ignore this file). Every Marko delimiter is a visible named node,
; so tags, expression delimiters, and placeholders all pair.

(element
  (open_tag_start) @open
  (open_tag_end) @close)

(element
  (open_tag_start) @open
  (open_tag_end_self) @close)

(close_tag
  (close_tag_start) @open
  (close_tag_end) @close)

(args
  (args_open) @open
  (args_close) @close)

(params
  (params_open) @open
  (params_close) @close)

(type_args
  (type_open) @open
  (type_close) @close)

(type_params
  (type_open) @open
  (type_close) @close)

(attr_group
  (attr_group_open) @open
  (attr_group_close) @close)

(method_body
  (method_body_open) @open
  (method_body_close) @close)

(scriptlet_block
  (scriptlet_block_open) @open
  (scriptlet_block_close) @close)

(placeholder
  (placeholder_start) @open
  (placeholder_end) @close)

(placeholder
  (placeholder_start_raw) @open
  (placeholder_end) @close)
