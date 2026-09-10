import { existsSync, readFileSync } from "node:fs";
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

/** Splits a module id into its path and its `?query`/`#hash` suffix. */
function splitId(id: string): [path: string, suffix: string] {
  const index = id.search(/[?#]/);
  return index === -1 ? [id, ""] : [id.slice(0, index), id.slice(index)];
}

/**
 * Queries that mean "do not give me this module's compiled form".
 *
 * Mirrors Vite's own `SPECIAL_QUERY_RE`. `?raw` wants the file's text, `?url`
 * its URL, `?worker`/`?sharedworker` a worker wrapper — in every case Vite
 * serves the real file itself, so MX must not claim the id or print it.
 */
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/**
 * A one-line code frame: the offending line plus a caret under `column`.
 *
 * Vite does not export `generateCodeFrame` from its public entry (checked at
 * runtime against 8.2.2: the export is `undefined`), so the frame the error
 * overlay renders is built here instead. `line` is 1-based and `column` is
 * 0-based, matching what the Babel parser raises.
 */
export function codeFrame(
  source: string,
  line: number,
  column: number,
): string {
  const lines = source.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return "";

  const gutter = `${line} | `;
  const caretPad = " ".repeat(gutter.length + Math.max(0, column));
  return `${gutter}${target}\n${caretPad}^`;
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
 *
 * The path itself comes from Vite's own resolver (`this.resolve`), never from
 * arithmetic here. Doing the path math locally got every non-trivial form
 * wrong: it mangled the importer's directory, treated root-relative and
 * `/@fs/` ids as filesystem paths, and never resolved aliases or bare
 * specifiers at all.
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

    async resolveId(id: string, importer: string | undefined) {
      const [path, suffix] = splitId(id);

      // `?raw`, `?url`, `?worker`: the caller wants the file itself, not the
      // module MX would print. Decline so Vite serves the real `.solid.mx` —
      // rewriting here would point its raw handler at a path that does not
      // exist on disk.
      if (SPECIAL_QUERY_RE.test(id)) return null;

      // Already rewritten (a re-resolve of our own id): keep it as is.
      if (isMxModule(path)) return id;
      if (!isMxFile(path)) return null;

      // Delegate to Vite: this handles relative ids against the real importer
      // directory, root-relative (`/src/x.solid.mx`) and `/@fs/` forms,
      // `resolve.alias`, and bare specifiers into workspace packages.
      // `skipSelf` stops this hook from recursing into itself.
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) return null;

      const [resolvedPath, resolvedSuffix] = splitId(resolved.id);
      if (!isMxFile(resolvedPath)) return null;

      // Carry the query across the rewrite. Vite appends its own (`?t=` on an
      // HMR re-fetch, `?import`), and dropping it would turn a cache-busted
      // request into a stale one.
      return resolvedPath + MX_SUFFIX + (resolvedSuffix || suffix);
    },

    load(id: string) {
      const [path] = splitId(id);
      if (!isMxModule(path)) return null;

      // A real `Foo.solid.mx.tsx` on disk is a different module and must not
      // be shadowed: only claim the id when the un-suffixed `.solid.mx` file
      // is the one that actually exists.
      const source = sourcePath(path);
      if (!existsSync(source)) return null;

      return readFileSync(source, "utf8");
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
      const [file] = splitId(ctx.file);
      if (!isMxFile(file)) return;

      const graph = ctx.server.moduleGraph;
      const mod = graph.getModuleById(file + MX_SUFFIX);
      if (!mod) return;

      graph.invalidateModule(mod);
      return [...ctx.modules, mod];
    },

    transform(code: string, id: string) {
      const [path] = splitId(id);
      if (!isMxModule(path)) return null;

      // Print against the real `.solid.mx` path so the source map and any
      // error position name the file the user actually wrote.
      const source = sourcePath(path);

      try {
        const { code: printed, map } = print(code, source);
        return { code: printed, map };
      } catch (err) {
        if (!isSyntaxError(err) || !err.loc) throw err;

        // Re-raise with the shape Vite's overlay reads, so the reported
        // position is the `.solid.mx` line rather than a position inside the
        // JSX text the user never wrote.
        const wrapped = err as MxSyntaxError & {
          id?: string;
          frame?: string;
          loc: { file: string; line: number; column: number };
        };

        // Babel appends its own 1-based `(line:column)` to the message while
        // `loc.column` is 0-based. Leaving both in place shows the reader two
        // different columns for one error, so drop the suffix and let `loc`
        // and `frame` carry the position.
        wrapped.message = err.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
        wrapped.id = source;
        wrapped.loc = {
          file: source,
          line: err.loc.line,
          column: err.loc.column,
        };
        wrapped.frame = codeFrame(code, err.loc.line, err.loc.column);

        throw wrapped;
      }
    },
  };
}
