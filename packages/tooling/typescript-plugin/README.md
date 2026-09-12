# `@mxlang/typescript-plugin`

A [Volar](https://volarjs.dev) language plugin and tsserver plugin that make a
`.solid.mx` file type-check as the TSX it lowers to, so an editor reports real
TypeScript errors inside MX regions and types an `import` of one from ordinary
`.ts`/`.tsx` code.

This is the editor half of decision 81. The CI half is
[`@mxlang/tsc`](../tsc/README.md), which hands the *same* language plugin to
Volar's `runTsc` — one lowering, so an editor and a build cannot disagree about
whether a file compiles.

## What it does

`createSolidMxLanguagePlugin(ts)` builds a `LanguagePlugin<string>`:

- `getLanguageId` reports `solidmx` for any `*.solid.mx` path.
- `createVirtualCode` runs `@mxlang/parser`'s `print(source, filename)` and
  wraps the printed TSX in a `VirtualCode` whose `CodeMapping`s are decoded
  from the returned source map, with `verification`, `completion`, `semantic`
  and `navigation` all enabled.
- `typescript.extraFileExtensions` declares `solid.mx` as
  `{ isMixedContent: false, scriptKind: TSX }`, and `getServiceScript` serves
  the virtual code as `.tsx`.

When `print` throws — a syntax error in an MX region, raised by the parser
bridge with a `loc` — the virtual code is empty and the error is recorded
instead. The tsserver plugin appends it to `getSyntacticDiagnostics` so it
shows up exactly once, at its own position, in the editor's normal diagnostics
list rather than as a silent empty file.

`createCompoundExtensionResolver(ts)` is a second, deliberately inert plugin:
it claims no file (`getLanguageId` and `getServiceScript` both return
undefined) and exists only to advertise the terminal `mx` suffix. Volar 2.4.28
assumes a custom extension is a single suffix, so for `X.solid.mx` TypeScript
probes `X.solid.d.mx.ts`; without the extra extension that probe fails and
every `import "./X.solid.mx"` is `TS2307`. Both this package and `@mxlang/tsc`
install it, so an editor and CI resolve imports identically.

## Mapping accuracy

Diagnostics land on the exact source column, not the start of the region. The
printer's own map is line-based, so the columns come from the parser bridge
repositioning each Babel node onto the source expression it was copied from
(`packages/parser/src/mx/bridge.ts`). `decodeMappings` then turns that map into
`CodeMapping`s, keeping only spans whose generated and source text actually
match and merging contiguous ones.

A type error inside an MX attribute expression therefore reports where the
expression is:

```tsx
export const el = <button onClick() { setCount(count() + "x") }>x</button>;
//                                             ~~~~~~~~~~~~~
// TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

## Using it

Add it to a project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

That is enough for an editor whose TypeScript integration honours
`compilerOptions.plugins`. No ambient `declare module "*.solid.mx"` shim is
needed — and adding one is actively harmful, since it replaces each file's real
exported types with whatever the shim asserts. `examples/counter-app` and
`examples/todomvc` both dropped theirs.

`tsc` itself ignores `plugins`, so a command-line typecheck needs
[`@mxlang/tsc`](../tsc/README.md)'s `mx-tsc` instead.

### Zed

Zed's TypeScript support runs `vtsls`. Register the plugin globally:

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "typescript": {
            "globalPlugins": [
              {
                "name": "@mxlang/typescript-plugin",
                "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
                "languages": ["solidmx"],
                "enableForWorkspaceTypeScriptVersions": true
              }
            ]
          }
        }
      }
    }
  }
}
```

**`languages` must be `solidmx`, lowercase.** `vtsls` matches this against the
LSP language id, not against the name in Zed's language config. Zed derives
that id by lowercasing the language's name — `LanguageName::lsp_id()` in
`crates/language_core/src/language_name.rs` is
`match self.0.as_ref() { "Plain Text" => "plaintext", name => name.to_lowercase() }`
— so the `SolidMX` language declared in
`packages/editors/zed/languages/solidmx/config.toml` is sent over LSP as
`solidmx`. That happens to be the same string this plugin's
`SOLID_MX_LANGUAGE_ID` uses, but the two are independent: `vtsls` never sees
the plugin's constant.

With `typescript-language-server` instead of `vtsls`, the equivalent is its
`plugins` array:

```json
{
  "lsp": {
    "typescript-language-server": {
      "initialization_options": {
        "plugins": [
          {
            "name": "@mxlang/typescript-plugin",
            "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
            "languages": ["solidmx"]
          }
        ]
      }
    }
  }
}
```

### VS Code

VS Code reads `compilerOptions.plugins` from the workspace `tsconfig.json`
automatically, but only for the workspace TypeScript version. To load the
plugin regardless, point at it explicitly:

```json
{
  "typescript.tsserver.pluginPaths": ["./node_modules/@mxlang/typescript-plugin"]
}
```

A dedicated extension would instead contribute it from its own `package.json`,
which is the form that needs no user setting at all:

```json
{
  "contributes": {
    "typescriptServerPlugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

No such extension ships from this repo yet.

## Relationship to `@mxlang/language-server`

They do not overlap. `@mxlang/language-server` diagnoses whole-file `.mx`
templates against a host policy and has no `.solid.mx` document path;
this plugin lives inside tsserver and does only TypeScript. Both can be
registered against the same file kind — that is how ESLint and TypeScript
coexist in one editor.

## Tests

`src/index.test.ts` drives a real `ts.LanguageService` built over the plugin:
the virtual code's shape and service script, mapping decode, the two
column-accuracy cases (an error inside an attribute method, and one on the
region's first line), the syntax-error diagnostic, and resolving plus typing a
`.solid.mx` import from a `.ts` file.

```
bunx vitest run --root ../../.. --project @mxlang/typescript-plugin
```
