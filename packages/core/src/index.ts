/**
 * `@mxlang/core` — the Marko-node consumer every MX host is built on.
 *
 * See `README.md` for what belongs here and what belongs in a host. The two
 * front doors are `compileSource` (a whole file, through
 * `@marko/compiler`'s `config.translator` seam) and `parseFragment` (a
 * substring of a larger file, positions shifted to the file).
 */

export {
  type CompileResult,
  compileSource,
  createTranslator,
  type HostOptions,
  type Lookup,
  type RawSourceMap,
} from "./compile.ts";
/**
 * The core's surface.
 *
 * Note that `blockFunction`, `emitAttrs`, `emitChildren`, `emitConst`,
 * `emitDefine`, `emitExpression`, `emitFor`, `emitIfChain`, `emitLiteral`,
 * `emitProgram` and `emitStatement` are the **pre-IR string-walk surface**,
 * retained only because `@mxlang/astro`'s `.amx` emitter still walks Marko
 * nodes directly (follow-up task `astro-ir-port`). A new host implements
 * `Emitter` and compiles through `HostOptions.emitIr` instead; nothing here
 * should grow a second caller.
 */
export {
  attrByName,
  type BindingRegistry,
  type BindingRewrite,
  blockFunction,
  type Ctx,
  type Disposition,
  DYNAMIC_TAG,
  declName,
  emitAttrs,
  emitChildren,
  emitConst,
  emitDefine,
  emitExpression,
  emitFor,
  emitIfChain,
  emitLiteral,
  emitProgram,
  emitStatement,
  expr,
  fail,
  hasContent,
  importBindings,
  type Node,
  newCtx,
  type Policy,
  propKey,
  push,
  quote,
  rejectUnsupportedFields,
  sliceLoc,
  TranslateError,
  VOID_TAGS,
} from "./core.ts";
export type { HostDeclarations } from "./declarations.ts";
export { drive, type Emitter, emit } from "./emit.ts";
export { escape } from "./escape.ts";
export {
  type FragmentBase,
  type FragmentResult,
  parseFragment,
} from "./fragment.ts";
export type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  ComponentTarget,
  Expr,
  ForSource,
  HostTag,
  Ir,
  IrNode,
  Position,
} from "./ir.ts";
export { resolve, resolveChildren } from "./resolve.ts";
