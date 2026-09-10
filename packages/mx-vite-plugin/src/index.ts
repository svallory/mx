import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { print } from "@mx/parser";
import type { Plugin } from "vite";

export interface MxPluginOptions {
  /**
   * File extensions handled by the plugin. Defaults to `.solid.mx`; `.mx`
   * becomes meaningful once a target other than Solid exists.
   */
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = [".solid.mx"];

/**
 * Appended to the resolved path so the rest of the pipeline sees a `.tsx`
 * module. See the note on `resolveId` below for why this is necessary.
 */
export const MX_SUFFIX = ".tsx";

/** A parse error as the vendored Babel parser raises it. */
interface MxSyntaxError extends Error {
  loc?: { line: number; column: number; index?: number };
  pos?: number;
  code?: string;
  reasonCode?: string;
}

function isSyntaxError(err: unknown): err is MxSyntaxError {
  return err instanceof Error && "loc" in err;
}

/** Strips Vite's `?query` and `#hash` suffixes from a module id. */
function cleanId(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

/**
 * Prints `.solid.mx` to JSX source text ahead of `@solidjs/vite-plugin`.
 *
 * Ordering: this plugin is `enforce: "pre"`, matching `@solidjs/vite-plugin`'s
 * own hard-coded `enforce: "pre"`, so relative order between the two is the
 * order they appear in the user's `plugins` array — put `mx()` first. Solid
 * then sees ordinary JSX text and runs whichever compiler it is configured
 * for; both the native (default) and Babel backends consume source text, so
 * neither needs special-casing here.
 *
 * Why `resolveId` rewrites the id to `<path>.solid.mx.tsx` rather than just
 * returning the resolved path — three separate parts of the pipeline dispatch
 * on the file extension, and `.solid.mx` satisfies none of them:
 *
 * 1. Vite routes a module into the JS pipeline only when its extension matches
 *    `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). Without a `resolveId` hook the
 *    import is never resolved at all and `transform` never runs.
 * 2. Rolldown picks its parser dialect from the extension, so the printed JSX
 *    is parsed as plain JS ("Unexpected JSX expression"). Returning
 *    `moduleType: "tsx"` from `transform` fixes the parse but then hands the
 *    module to rolldown's own JSX transform, which resolves
 *    `react/jsx-runtime`.
 * 3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, whose
 *    default is `src/**\/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`; that test runs
 *    before its `options.extensions` list is consulted, so registering the
 *    extension there cannot bring `.solid.mx` back in.
 *
 * A `.tsx`-suffixed id satisfies all three at once with no configuration on
 * the user's side, which is why the example's `vite.config.ts` is just
 * `plugins: [mx(), solid()]`. `load` reads the real file from disk (strip the
 * suffix) and `transform` prints it; diagnostics keep the original filename.
 */
export default function mx(options: MxPluginOptions = {}): Plugin {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const isMxFile = (file: string) =>
    extensions.some((ext) => file.endsWith(ext));
  const isMxModule = (file: string) =>
    extensions.some((ext) => file.endsWith(ext + MX_SUFFIX));
  /** `/a/App.solid.mx.tsx` -> `/a/App.solid.mx` */
  const sourcePath = (file: string) => file.slice(0, -MX_SUFFIX.length);

  return {
    name: "mx",
    enforce: "pre",

    resolveId(id: string, importer: string | undefined) {
      const file = cleanId(id);
      // Already rewritten (a re-resolve of our own id): keep it as is.
      if (isMxModule(file)) return file;
      if (!isMxFile(file)) return null;

      if (isAbsolute(file)) return file + MX_SUFFIX;
      if (!importer) return null;
      const base = dirname(sourcePath(cleanId(importer)));
      return resolve(base, file) + MX_SUFFIX;
    },

    load(id: string) {
      const file = cleanId(id);
      if (!isMxModule(file)) return null;
      return readFileSync(sourcePath(file), "utf8");
    },

    /**
     * Bridges the on-disk file back to the suffixed module.
     *
     * Vite keys its module graph by the resolved id, which for MX is
     * `<path>.solid.mx.tsx` — a path that does not exist on disk. An edit to
     * the real `<path>.solid.mx` therefore matches no module, so without this
     * hook Vite finds nothing to invalidate and sends no update at all.
     */
    handleHotUpdate(ctx) {
      const file = cleanId(ctx.file);
      if (!isMxFile(file)) return;

      const graph = ctx.server.moduleGraph;
      const mod = graph.getModuleById(file + MX_SUFFIX);
      if (!mod) return;

      graph.invalidateModule(mod);
      return [...ctx.modules, mod];
    },

    transform(code: string, id: string) {
      const file = cleanId(id);
      if (!isMxModule(file)) return null;

      // Print against the real `.solid.mx` path so the source map and any
      // error position name the file the user actually wrote.
      const source = sourcePath(file);

      try {
        const { code: printed, map } = print(code, source);
        return { code: printed, map };
      } catch (err) {
        if (!isSyntaxError(err) || !err.loc) throw err;

        // Re-raise with the shape Vite's overlay reads, so the reported
        // position is the `.solid.mx` line rather than a position inside the
        // JSX text the user never wrote. Babel columns are 0-based and Vite
        // renders them as-is.
        const wrapped = err as MxSyntaxError & {
          id?: string;
          loc: { file: string; line: number; column: number };
        };
        wrapped.id = source;
        wrapped.loc = {
          file: source,
          line: err.loc.line,
          column: err.loc.column,
        };
        throw wrapped;
      }
    },
  };
}
