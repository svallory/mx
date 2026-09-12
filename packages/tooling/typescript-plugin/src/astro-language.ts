import { createRequire } from "node:module";
import type { LanguagePlugin, VirtualCode } from "@volar/language-core";

interface UriLike {
  path: string;
  fsPath: string;
}

type AstroLanguagePlugin = LanguagePlugin<UriLike, VirtualCode>;
export type AstroLanguagePluginLoader = () => AstroLanguagePlugin;

/**
 * Loads Astro's language plugin only for an explicitly enabled Astro project,
 * then adapts its URI-keyed API to the file-name keys tsserver uses.
 */
export function createAstroLanguagePlugin(
  load: AstroLanguagePluginLoader = loadAstroLanguagePlugin,
): LanguagePlugin<string> {
  let astro: AstroLanguagePlugin;
  try {
    astro = load();
  } catch (cause) {
    throw new Error(
      "@mxlang/typescript-plugin: `astro: true` requires the optional peer dependency `@astrojs/language-server@2.16.16`; install it beside the plugin.",
      { cause },
    );
  }

  const adapted: LanguagePlugin<string> = {
    getLanguageId(fileName) {
      return astro.getLanguageId?.(toUri(fileName));
    },
    createVirtualCode(fileName, languageId, snapshot, context) {
      return astro.createVirtualCode?.(
        toUri(fileName),
        languageId,
        snapshot,
        context as never,
      );
    },
    typescript: astro.typescript
      ? {
          ...astro.typescript,
          // Volar's runTsc path cannot host Astro's auxiliary .mjs/.mts
          // scripts; the main TSX service script is the one typecheck needs.
          getExtraServiceScripts: undefined,
        }
      : undefined,
  };
  if (astro.updateVirtualCode) {
    adapted.updateVirtualCode = (fileName, code, snapshot, context) =>
      astro.updateVirtualCode?.(
        toUri(fileName),
        code,
        snapshot,
        context as never,
      );
  }
  if (astro.disposeVirtualCode) {
    adapted.disposeVirtualCode = (fileName, code) =>
      astro.disposeVirtualCode?.(toUri(fileName), code);
  }
  adapted.isAssociatedFileOnly = (fileName, languageId) =>
    fileName.replace(/\\/g, "/").includes("/node_modules/") ||
    (astro.isAssociatedFileOnly?.(toUri(fileName), languageId) ?? false);
  return adapted;
}

function loadAstroLanguagePlugin(): AstroLanguagePlugin {
  const require = createRequire(import.meta.url);
  const module = require("@astrojs/language-server/dist/core/index.js") as {
    getAstroLanguagePlugin(): AstroLanguagePlugin;
  };
  return module.getAstroLanguagePlugin();
}

function toUri(fileName: string): UriLike {
  const normalized = fileName.replace(/\\/g, "/");
  return { path: normalized, fsPath: fileName };
}
