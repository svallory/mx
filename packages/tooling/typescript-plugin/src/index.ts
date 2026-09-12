import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin";
import type * as ts from "typescript";
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
    | Array<SolidMxLanguagePlugin | MxLanguagePlugin>
    | undefined;
  const volarFactory = createLanguageServicePlugin((typescript) => {
    const solidMxPlugin = createSolidMxLanguagePlugin(typescript);
    const mxPlugin = createMxLanguagePlugin(typescript);
    languagePlugins = [solidMxPlugin, mxPlugin];
    return {
      languagePlugins: [
        ...languagePlugins,
        createCompoundExtensionResolver(typescript),
      ],
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
          fileName.endsWith(".marko"),
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

function withSyntaxDiagnostics(
  typescript: typeof ts,
  service: ts.LanguageService,
  getLanguagePlugins: () =>
    | Array<SolidMxLanguagePlugin | MxLanguagePlugin>
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
            source: fileName.endsWith(".solid.mx") ? "solidmx" : "mx",
            messageText: error.message,
          },
        ];
      };
    },
  });
}

export {
  createCompoundExtensionResolver,
  createSolidMxLanguagePlugin,
} from "./language.ts";
export { createHtmlMappings, createMxLanguagePlugin } from "./mx-language.ts";
export default pluginFactory;
