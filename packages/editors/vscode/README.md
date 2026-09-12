# `@mxlang/vscode`

The dedicated VS Code extension is still a stub. Until it ships, use the
official Marko extension for `.mx` highlighting and formatting, and a generic
LSP client for MX host diagnostics.

Associate whole-file MX with Marko and give SolidMX its own language id:

```json
{
  "files.associations": {
    "*.mx": "marko",
    "*.solid.mx": "solidmx"
  }
}
```

A generic LSP client configuration should launch the diagnostics server for
both ids:

```json
{
  "command": "bunx",
  "args": ["@mxlang/language-server", "--stdio"],
  "filetypes": ["marko", "mx", "solidmx"]
}
```

The server parses `.solid.mx` as TypeScript/TSX with MX regions and reports
Solid host errors at positions in the complete file. It can also report
ordinary TypeScript syntax errors because region discovery requires parsing
the complete module; TypeScript's own server may report the same error.
