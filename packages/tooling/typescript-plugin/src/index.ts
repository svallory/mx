import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin";
import type * as ts from "typescript";
import {
  type AmxLanguagePlugin,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
import {
  type AstroLanguagePluginLoader,
  createAstroLanguagePlugin,
} from "./astro-language.ts";
import {
  createCompoundExtensionResolver,
  createSolidMxLanguagePlugin,
  type SolidMxLanguagePlugin,
} from "./language.ts";
import {
  createMxLanguagePlugin,
  type MxLanguagePlugin,
} from "./mx-language.ts";

const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  let languagePlugins:
    | Array<SolidMxLanguagePlugin | MxLanguagePlugin | AmxLanguagePlugin>
    | undefined;
  const volarFactory = createLanguageServicePlugin((typescript, info) => {
    const solidMxPlugin = createSolidMxLanguagePlugin(typescript);
    const mxPlugin = createMxLanguagePlugin(typescript);
    languagePlugins = [solidMxPlugin, mxPlugin];
    if (info.config?.astro === true) {
      languagePlugins.push(createAmxLanguagePlugin(typescript));
    }
    return {
      languagePlugins: createConfiguredLanguagePlugins(
        typescript,
        info.config?.astro === true,
        undefined,
        languagePlugins,
      ),
    };
  });
  const pluginModule = volarFactory(modules);

  return {
    ...pluginModule,
    getExternalFiles(project, updateLevel) {
      return (
        pluginModule.getExternalFiles?.(project, updateLevel) ?? []
      ).filter(
        (fileName) =>
          fileName.endsWith(".solid.mx") ||
          fileName.endsWith(".mx") ||
          fileName.endsWith(".marko") ||
          fileName.endsWith(".amx") ||
          fileName.endsWith(".astro"),
      );
    },
    create(info) {
      const service = pluginModule.create(info);
      return withSyntaxDiagnostics(
        modules.typescript,
        service,
        () => languagePlugins,
      );
    },
  };
};

export function createConfiguredLanguagePlugins(
  typescript: typeof ts,
  astro: boolean,
  loadAstro?: AstroLanguagePluginLoader,
  mxPlugins: Array<
    SolidMxLanguagePlugin | MxLanguagePlugin | AmxLanguagePlugin
  > = [
    createSolidMxLanguagePlugin(typescript),
    createMxLanguagePlugin(typescript),
  ],
) {
  return [
    ...mxPlugins,
    ...(astro &&
    !mxPlugins.some(
      (plugin) => plugin.getLanguageId?.("component.amx") === "astromx",
    )
      ? [createAmxLanguagePlugin(typescript)]
      : []),
    ...(astro ? [createAstroLanguagePlugin(loadAstro)] : []),
    createCompoundExtensionResolver(typescript),
  ];
}

function withSyntaxDiagnostics(
  typescript: typeof ts,
  service: ts.LanguageService,
  getLanguagePlugins: () =>
    | Array<SolidMxLanguagePlugin | MxLanguagePlugin | AmxLanguagePlugin>
    | undefined,
): ts.LanguageService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property !== "getSyntacticDiagnostics") {
        return Reflect.get(target, property, receiver);
      }

      return (fileName: string) => {
        const diagnostics = target.getSyntacticDiagnostics(fileName);
        const error = getLanguagePlugins()
          ?.map((plugin) => plugin.getSyntaxError(fileName))
          .find((candidate) => candidate !== undefined);
        if (!error) return diagnostics;

        const file = typescript.createSourceFile(
          fileName,
          error.source,
          typescript.ScriptTarget.Latest,
          false,
          typescript.ScriptKind.TSX,
        );
        return [
          ...diagnostics,
          {
            file,
            start: error.offset,
            length: Math.min(1, error.source.length - error.offset),
            category: typescript.DiagnosticCategory.Error,
            code: 80001,
            source: fileName.endsWith(".solid.mx")
              ? "solidmx"
              : fileName.endsWith(".amx")
                ? "amx"
                : "mx",
            messageText: error.message,
          },
        ];
      };
    },
  });
}

export {
  composeAmxMappings,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
export { createAstroLanguagePlugin } from "./astro-language.ts";
export {
  createCompoundExtensionResolver,
  createSolidMxLanguagePlugin,
} from "./language.ts";
export {
  createAstroTypeSurface,
  createHtmlMappings,
  createMxLanguagePlugin,
} from "./mx-language.ts";
export default pluginFactory;
