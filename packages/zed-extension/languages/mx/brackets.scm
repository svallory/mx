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

; --- MX overlay (overlay/mx/brackets.scm) ---
; MX-specific bracket overlay, concatenated onto marko-js/zed's languages/marko/brackets.scm
; by scripts/vendor.sh. Empty for now: MX uses the Marko grammar unmodified, so upstream's
; bracket pairs already cover every delimiter MX emits.
