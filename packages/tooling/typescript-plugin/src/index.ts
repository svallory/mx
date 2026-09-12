import type { LanguagePlugin } from "@volar/language-core";
import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin";
import type * as ts from "typescript";
import {
  createSolidMxLanguagePlugin,
  type SolidMxLanguagePlugin,
} from "./language.ts";

const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  let languagePlugin: SolidMxLanguagePlugin | undefined;
  const volarFactory = createLanguageServicePlugin((typescript) => {
    languagePlugin = createSolidMxLanguagePlugin(typescript);
    return {
      languagePlugins: [languagePlugin, compoundExtensionResolver(typescript)],
    };
  });
  const pluginModule = volarFactory(modules);

  return {
    ...pluginModule,
    getExternalFiles(project, updateLevel) {
      return (
        pluginModule.getExternalFiles?.(project, updateLevel) ?? []
      ).filter((fileName) => fileName.endsWith(".solid.mx"));
    },
    create(info) {
      const service = pluginModule.create(info);
      return withSyntaxDiagnostics(
        modules.typescript,
        service,
        () => languagePlugin,
      );
    },
  };
};

/**
 * Volar 2.4.28's resolver assumes custom extensions contain one suffix. For
 * `X.solid.mx`, TypeScript probes `X.solid.d.mx.ts`; advertising the terminal
 * `mx` suffix lets Volar redirect that probe to the real source. External-file
 * discovery is filtered above, so ordinary whole-file `.mx` templates never
 * enter the TypeScript project.
 */
function compoundExtensionResolver(
  typescript: typeof ts,
): LanguagePlugin<string> {
  return {
    getLanguageId: () => undefined,
    typescript: {
      extraFileExtensions: [
        {
          extension: "mx",
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript: () => undefined,
    },
  };
}

function withSyntaxDiagnostics(
  typescript: typeof ts,
  service: ts.LanguageService,
  getLanguagePlugin: () => SolidMxLanguagePlugin | undefined,
): ts.LanguageService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property !== "getSyntacticDiagnostics") {
        return Reflect.get(target, property, receiver);
      }

      return (fileName: string) => {
        const diagnostics = target.getSyntacticDiagnostics(fileName);
        const error = getLanguagePlugin()?.getSyntaxError(fileName);
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
            source: "solidmx",
            messageText: error.message,
          },
        ];
      };
    },
  });
}

export { createSolidMxLanguagePlugin } from "./language.ts";
export default pluginFactory;
