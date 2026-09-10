; MX-specific highlight overlay, concatenated onto upstream marko-js/tree-sitter's
; queries/highlights.scm by scripts/vendor.sh. Empty for now: MX uses the Marko
; grammar unmodified and upstream's highlights already cover every node MX emits.
; Reactive-only tags Marko allows but MX's compiler rejects still highlight as
; ordinary elements (see notes/zed-extension-plan.md decision 3) — acceptable in v1.
