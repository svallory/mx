// External scanner for the solidmx grammar.
//
// Two scanners meet here, and they are kept in separate files on purpose
// (plan decision 5, Z2):
//
//   * `common/scanner.h` is upstream tree-sitter-typescript's, vendored
//     untouched. It provides the tsx tokens — automatic semicolons, template
//     chars, the ternary `?`, regex patterns and so on.
//
//   * `scanner_mx.c` is MX's own, holding every MX addition. Keeping it out of
//     upstream's file means an upstream bump that rewrites `scanner.h` shows up
//     as a patch conflict at the vendor step rather than silently merging into
//     MX code.
//
// This file is the thin entry point tree-sitter compiles: it dispatches to the
// MX scanner when the MX token is valid, and otherwise defers to upstream.

#include "../vendor/tree-sitter-typescript/common/scanner.h"

// `scanner_mx.c` is included rather than compiled separately: tree-sitter
// builds exactly one `src/scanner.c` per grammar, and Zed's extension builder
// does the same (Z7). It defines the MX token id and the region scan.
#include "scanner_mx.c"

void *tree_sitter_solidmx_external_scanner_create(void) { return NULL; }

void tree_sitter_solidmx_external_scanner_destroy(void *payload) { (void)payload; }

unsigned tree_sitter_solidmx_external_scanner_serialize(void *payload, char *buffer) {
    (void)payload;
    (void)buffer;
    return 0; // both scanners are stateless across tokens
}

void tree_sitter_solidmx_external_scanner_deserialize(void *payload, const char *buffer,
                                                      unsigned length) {
    (void)payload;
    (void)buffer;
    (void)length;
}

bool tree_sitter_solidmx_external_scanner_scan(void *payload, TSLexer *lexer,
                                               const bool *valid_symbols) {
    // MX first: when the grammar admits an MX element here, the whole region is
    // one token and none of upstream's tokens can apply at that position.
    if (valid_symbols[MX_ELEMENT] && mx_scan_element_token(lexer)) {
        return true;
    }
    return external_scanner_scan(payload, lexer, valid_symbols);
}
