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
  type TranslatorOptions,
} from "./compile.ts";
export {
  attrByName,
  type BindingRegistry,
  type BindingRewrite,
  type Ctx,
  type Disposition,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  hasContent,
  importBindings,
  type Node,
  newCtx,
  propKey,
  quote,
  rejectUnsupportedFields,
  sliceLoc,
  TranslateError,
  VOID_TAGS,
} from "./core.ts";
export type { HostDeclarations, Policy } from "./declarations.ts";
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
  ExprShape,
  ForSource,
  HostTag,
  Ir,
  IrNode,
  Position,
} from "./ir.ts";
export { expressionShape, resolve, resolveChildren } from "./resolve.ts";
