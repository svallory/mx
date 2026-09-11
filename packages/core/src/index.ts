/**
 * `@markox/core` — the Marko-node consumer every MX host is built on.
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
export { escape } from "./escape.ts";
export {
  type FragmentBase,
  type FragmentResult,
  parseFragment,
} from "./fragment.ts";
