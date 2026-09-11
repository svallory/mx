/**
 * `@mxlang/astro` — the Astro host for MX.
 *
 * MX (Markup eXtended) is a template language born from Marko, MX 1.0 being a
 * strict subset of Marko's syntax (decision 72). This package renders `.mx`
 * (and its `.marko` alias) components inside an Astro project as **static
 * markup**: they are compiled by `@mxlang/translator` to a runtime-free
 * `(input) => string` function, called during Astro's build, and never shipped
 * to a browser.
 *
 * Two pieces, and no third: an integration that registers a renderer and adds
 * MX's existing Vite plugin, and the renderer's own server entrypoint
 * (`./server.ts`). The compile step is `@mxlang/vite-plugin` unchanged — an
 * Astro project is a Vite project, and that plugin already turns a `.mx` file
 * into a plain module.
 */

import mx from "@mxlang/vite-plugin";
import { mxPages } from "./vite-pages.ts";
import { mxTemplates } from "./vite-templates.ts";

/**
 * Astro's integration surface, to the depth this file uses it.
 *
 * Declared locally rather than imported from `astro`: the package is a
 * *peer* of a consumer's own Astro install, and typing against these two
 * callbacks keeps `astro` a devDependency here (for the example and the
 * tests) instead of a hard runtime dependency of every consumer.
 */
interface AstroRenderer {
  name: string;
  serverEntrypoint: string;
  clientEntrypoint?: string;
}

interface AstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup"?: (options: {
      config: { srcDir: URL };
      addRenderer: (renderer: AstroRenderer) => void;
      addPageExtension: (ext: string) => void;
      updateConfig: (config: Record<string, unknown>) => void;
    }) => void;
  };
}

export interface MxIntegrationOptions {
  /**
   * File extensions compiled as MX. Defaults to `.mx` and its `.marko` alias.
   *
   * `.solid.mx` is deliberately absent: that is a different file kind (TSX
   * with MX regions, lowered to Solid JSX), and it belongs to the Solid host,
   * not this one.
   */
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = [".mx", ".marko"];

/**
 * The Astro integration.
 *
 * ```js
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import mx from "@mxlang/astro";
 *
 * export default defineConfig({ integrations: [mx()] });
 * ```
 *
 * `clientEntrypoint` is omitted, which is a first-class shape in Astro's
 * `AstroRenderer` type rather than an omission it tolerates: a component with
 * no state and no runtime has nothing to hydrate.
 *
 * Astro does **not** guard a `client:*` directive on such a component, despite
 * shipping an error message for exactly that case. `NoClientEntrypoint` is
 * defined in `astro/dist/core/errors/errors-data.js` and thrown from nowhere
 * in astro@7.3.2 (verified by grepping the installed package: the only hits
 * are the definition and its `.d.ts`); the render path is a bare
 * `if (renderer.clientEntrypoint)` at `dist/runtime/server/hydration.js:98`
 * with no else branch. Left alone, a `client:load` builds cleanly and emits an
 * `<astro-island client="load">` whose loader falls back to a no-op hydrator —
 * an island that silently does nothing, on a host whose claim is shipping no
 * client JS.
 *
 * So **this host raises the error itself**, in `renderToStaticMarkup` when
 * Astro's `metadata.hydrate` is set: `client:*` on an MX component is an error
 * (decision 70), not something to discover in a bundle.
 * `examples/astro-static/e2e/build-errors.spec.ts` asserts the failing build.
 *
 * `strict: true` on the Vite plugin selects `@mxlang/translator`'s
 * `strictPolicy`: `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client`
 * blocks and `<id>` become compile errors naming the construct instead of
 * rendering their initial value or compiling away as inert. Decision 71 —
 * stateful tags mean whatever the host says, and this host has no reactive
 * target at all, so "this needs a runtime" is a build error rather than
 * markup that silently renders once and never updates.
 */
export default function mxAstro(
  options: MxIntegrationOptions = {},
): AstroIntegration {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;

  return {
    name: "@mxlang/astro",
    hooks: {
      "astro:config:setup": ({
        config,
        addRenderer,
        addPageExtension,
        updateConfig,
      }) => {
        addRenderer({
          name: "@mxlang/astro",
          serverEntrypoint: "@mxlang/astro/server",
        });

        // `.mx` files under `src/pages` are pages (decision 76b), not
        // components: `.marko` stays a component-only alias and is
        // deliberately not registered here, so a `.marko` file placed under
        // `src/pages` is invisible to Astro's router rather than half-page,
        // half-component.
        addPageExtension(".mx");

        updateConfig({
          vite: {
            plugins: [
              // `.astro.mx` first: it owns that extension outright, lowering
              // the MX template to Astro template syntax and handing the file
              // to Astro's own compiler (decision 76c). `mx()` declines the
              // extension itself, so the order is documentation rather than a
              // tie-break.
              mxTemplates(),
              mx({ extensions, strict: true }),
              mxPages(config.srcDir),
            ],
          },
        });
      },
    },
  };
}
