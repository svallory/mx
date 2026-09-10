export type { CompareOptions, CompareResult, CompareStatus } from "./compare";
export { compare } from "./compare";
export type {
  CompileOptions,
  MxParser,
  SolidGenerate,
  SolidVariant,
} from "./compile";
export { compile, compileFile, MxParserUnavailable, VARIANTS } from "./compile";
export { lineDiff } from "./diff";
export type { DivergenceEntry } from "./divergences";
export { findDivergence, parseDivergences } from "./divergences";
export { discoverFixtures } from "./fixtures";
export { normalize } from "./normalize";
