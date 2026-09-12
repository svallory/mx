# `@mxlang/typescript-plugin`

A [Volar](https://volarjs.dev) language plugin and tsserver plugin that type
`.solid.mx`, whole-file `.mx` and its `.marko` alias from their generated
TypeScript. Editors report errors inside templates and type imports from the
file's real exported `Input` interface.

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

`createMxLanguagePlugin(ts)` does the same job for whole-file `.mx` and
`.marko` templates. It resolves the host with `@mxlang/core`'s
`resolveHostPolicy` — the same resolver `@mxlang/language-server` uses, so an
editor, this plugin and a `tsc` run cannot disagree about which host owns a
file — applying the nearest `package.json`'s `mxlang.host` (`html`, `astro`, or
`solid`; default `html`) and strictness, then serves the compiled module as
TypeScript. Astro always uses strict HTML lowering and projects MX's runtime
`content` slot as JSX `children` at the type boundary.

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

Diagnostics land on the exact source column, not the start of the region. For
`.solid.mx`, the printer's map is line-based, so columns come from the bridge
repositioning each Babel node onto the source expression it was copied from
(`packages/parser/src/mx/bridge.ts`). `decodeMappings` then turns that map into
`CodeMapping`s, keeping only spans whose generated and source text actually
match and merging contiguous ones.

The HTML compiler's map is currently an empty placeholder. Whole-file `.mx`
mappings therefore come from the positioned nodes in the core IR that the HTML
emitter already consumes; unchanged code text is mapped directly into the
generated TypeScript.

A type error inside an MX attribute expression therefore reports where the
expression is:

```tsx
export const el = <button onClick() { setCount(count() + "x") }>x</button>;
//                                             ~~~~~~~~~~~~~
// TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

### What is mapped, and what happens when something is not

Whole-file `.mx`/`.marko` mapping covers two shapes:

- **Per expression**, exactly. Every `Expr` in the IR carries its original
  Babel node, so a placeholder, an attribute value, an `<if>` condition, a
  `<for>` iterable and a tag-param use each map to their own source span.
- **Per whole block**, for the five IR kinds whose code is a statement rather
  than an expression: `Static` (a `static`/`server` block), `Import`,
  `Export`, `InputInterface` (`export interface Input`) and `Hoisted` (a
  statement a host hook lifted). Each maps as one span covering the
  statement's own source range, so a diagnostic inside it lands within the
  author's own line instead of being dropped. TypeScript still anchors an
  error where it normally would — for `static const n: number = "x"` that is
  the declaration name `n`, not the initializer.

A mapping is emitted only when the code is located in both texts: the source
span must contain the code, and the generated text must still contain it (the
search runs forward, keyed per code string, so repeated text cannot cross-map
onto an earlier occurrence). When either lookup fails, **no mapping is
emitted** — deliberately, because mapping to a plausible-but-wrong column is
worse than not mapping. A diagnostic falling outside every mapping is not
surfaced against the `.mx` file, so an emitted construct that needs positions
must carry them in the IR rather than rely on a text search.

MX syntax errors are separate: `compile` throwing produces one positioned
syntax diagnostic (see above), not a mapping.

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

The same rule applies to `*.mx` and `*.marko`: do not add a wildcard shim.

### Astro projects

Astro and MX both use Volar. Two separate Volar tsserver plugins cannot
decorate the same project: whichever initializes second is silently skipped.
List only the MX plugin and ask it to compose Astro's language plugin:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@mxlang/typescript-plugin", "astro": true }
    ]
  }
}
```

Do not also list `@astrojs/ts-plugin`. Astro composition lazily loads the
optional peer `@astrojs/language-server@2.16.16`; a project that enables
`astro: true` must install that package beside this plugin.

Two behaviours of the composed Astro plugin are worth knowing:

- **`.astro` files under `node_modules` are associated-only.** They are
  Astro's own package-owned component sources, not the consumer's code, so
  they stay resolvable for imports while `mx-tsc` does not report diagnostics
  for files the consumer cannot edit. The check normalizes Windows separators
  before testing for the `/node_modules/` segment, so both path styles behave
  the same.
- **`children` is offered only where there is a slot.** An Astro-hosted `.mx`
  component's projected type replaces `content` with JSX's `children` only
  when its `Input` actually declares `content`. A component with no content
  slot keeps its `Input` unchanged, so passing children to it is a type error
  rather than silently accepted and dropped at runtime.

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
                "languages": ["solidmx", "mx", "astro"],
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

Language ids are lowercase. `vtsls` matches this array against the
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
            "languages": ["solidmx", "mx", "astro"]
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
the SolidMX and whole-file MX virtual-code shapes, IR-backed mapping accuracy,
syntax diagnostics, host resolution, import typing, and optional Astro
composition (enabled, disabled, and missing-peer cases).

```
bunx vitest run --root ../../.. --project @mxlang/typescript-plugin
```
