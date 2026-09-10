// biome-ignore-all lint/complexity/noBannedTypes: mirrors each page's `export interface Input {}`
/** Input shapes for the compiled pages, kept in sync by hand with `src/pages/*.mx`. */

export type IndexInput = Record<string, never>;

export interface ListInput {
  fruits: string[];
  tasks: { id: string; label: string }[];
}

export interface FormInput {
  username: string;
  bio: string;
  extraAttrs: Record<string, unknown>;
}

export interface MixinsInput {
  badges: string[];
}

export interface RawInput {
  markup: string;
}
