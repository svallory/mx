#!/usr/bin/env node
/**
 * The `mxlang-language-server` executable: `bunx @mxlang/language-server
 * --stdio` or `node dist/bin.js --stdio`. `vscode-languageserver`'s
 * `createConnection` auto-detects stdio when no other transport flag is
 * given, so `--stdio` is accepted for symmetry with Marko's own server
 * (README "Editors") but not otherwise inspected.
 */

import { startServer } from "./server.ts";

startServer();
