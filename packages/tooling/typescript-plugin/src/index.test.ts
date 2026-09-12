import { decode } from "@jridgewell/sourcemap-codec";
import { print } from "@mxlang/parser";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import pluginFactory from "./index.ts";
import {
  createSolidMxLanguagePlugin,
  decodeMappings,
  SOLID_MX_LANGUAGE_ID,
} from "./language.ts";
import {
  createHtmlMappings,
  createMxLanguagePlugin,
  MX_LANGUAGE_ID,
} from "./mx-language.ts";

describe("SolidMX language plugin", () => {
  it("recognizes .solid.mx and exposes a TSX service script", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const source = "export const answer: number = 42;\n";
    const virtual = plugin.createVirtualCode?.(
      "/src/example.solid.mx",
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/example.solid.mx")).toBe("solidmx");
    expect(plugin.getLanguageId("/src/example.tsx")).toBeUndefined();
    if (!virtual) throw new Error("Expected SolidMX virtual code");
    expect(virtual?.languageId).toBe("typescriptreact");
    expect(virtual?.snapshot.getText(0, virtual.snapshot.getLength())).toBe(
      "export const answer: number = 42;",
    );
    expect(virtual?.mappings.length).toBeGreaterThan(0);
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "solid.mx",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TSX,
      },
    ]);
    expect(plugin.typescript?.getServiceScript(virtual)).toMatchObject({
      code: virtual,
      extension: ".tsx",
      scriptKind: ts.ScriptKind.TSX,
      preventLeadingOffset: true,
    });
  });

  it("decodes the printer source map into feature-enabled mappings", () => {
    const source = "const el = <button title=value()>ok</button>;\n";
    const printed = print(source, "mapping.solid.mx");

    const mappings = decodeMappings(printed.map, printed.code, source);

    expect(decode(printed.map.mappings).flat().length).toBeGreaterThan(0);
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.every((mapping) => mapping.data.verification)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.completion)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.semantic)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.navigation)).toBe(true);
  });

  it("returns empty virtual code and records one positioned syntax error", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const fileName = "/src/broken.solid.mx";
    const source = "const el = <button>oops;\n";
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(virtual?.snapshot.getLength()).toBe(0);
    expect(virtual?.mappings).toEqual([]);
    expect(plugin.getSyntaxError(fileName)).toMatchObject({
      fileName,
      offset: source.indexOf("<button"),
      source,
    });
    expect(plugin.getSyntaxError(fileName)?.message).toContain(
      "Missing ending",
    );
  });

  it("reports a bridge syntax error once through tsserver diagnostics", () => {
    const fileName = "/project/broken.solid.mx";
    const consumer = "/project/index.ts";
    const source = "const el = <button>oops;\n";
    const service = createPluginService(
      {
        [fileName]: source,
        [consumer]: 'import "./broken.solid.mx";\n',
      },
      [consumer],
    );

    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSyntacticDiagnostics(fileName);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      start: source.indexOf("<button"),
      source: "solidmx",
      code: 80001,
      category: ts.DiagnosticCategory.Error,
    });
    expect(String(diagnostics[0]?.messageText)).toContain("Missing ending");
  });

  it("resolves and types a .solid.mx import from a TypeScript file", () => {
    const component = "/project/Counter.solid.mx";
    const consumer = "/project/index.ts";
    const service = createPluginService(
      {
        [component]: [
          "export function Counter(props: { start: number }) {",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: SolidMX placeholder syntax
          "  return <button>${props.start}</button>;",
          "}",
        ].join("\n"),
        [consumer]: [
          'import { Counter } from "./Counter.solid.mx";',
          'Counter({ start: "wrong" });',
        ].join("\n"),
      },
      [consumer],
    );

    const diagnostics = service.getSemanticDiagnostics(consumer);

    expect(diagnostics.some((diagnostic) => diagnostic.code === 2307)).toBe(
      false,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 2322,
          start: expect.any(Number),
        }),
      ]),
    );
  });

  it("maps an inline MX attribute-method type error to its exact column", () => {
    const component = "/project/Column.solid.mx";
    const consumer = "/project/index.ts";
    const expression = 'count() + "x"';
    const source = [
      "function setCount(value: number) {}",
      "const count = () => 0;",
      `export const el = <button onClick() { setCount(${expression}) }>x</button>;`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./Column.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(component);
    const diagnostic = diagnostics.find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });

  it("maps an expression on the MX region's first line after the opening tag", () => {
    const component = "/project/FirstLine.solid.mx";
    const consumer = "/project/index.ts";
    const expression = '"bad"';
    const source = [
      "function needsNumber(value: number) { return value; }",
      `export const el = <button title=needsNumber(${expression})>x</button>;`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./FirstLine.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(component);
    const diagnostic = diagnostics.find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });
});

describe("MX language plugin", () => {
  it("recognizes .mx and .marko and exposes a TypeScript service script", () => {
    const plugin = createMxLanguagePlugin(ts);
    const source = [
      "export interface Input { title: string }",
      "<h1>${input.title}</h1>",
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      "/src/card.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/card.mx")).toBe("mx");
    expect(plugin.getLanguageId("/src/card.marko")).toBe("mx");
    expect(plugin.getLanguageId("/src/card.solid.mx")).toBeUndefined();
    expect(plugin.getLanguageId("/src/card.ts")).toBeUndefined();
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(virtual.languageId).toBe("typescript");
    expect(generated).toContain("export interface Input { title: string }");
    expect(generated).toContain("function render(input: Input): string");
    expect(generated).toContain("out += escape(input.title)");
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "mx",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TS,
      },
      {
        extension: "marko",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TS,
      },
    ]);
    expect(plugin.typescript?.getServiceScript(virtual)).toMatchObject({
      code: virtual,
      extension: ".ts",
      scriptKind: ts.ScriptKind.TS,
      preventLeadingOffset: true,
    });
  });

  it("builds exact expression mappings from positioned HTML IR", () => {
    const source = [
      "export interface Input { count: number }",
      'static function needsNumber(value: number) { return value; }',
      '<p>before ${needsNumber(input.count + "x")} after</p>',
    ].join("\n");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/column.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    const mappings = createHtmlMappings(
      source,
      "/src/column.mx",
      generated,
      false,
    );
    const expression = 'needsNumber(input.count + "x")';
    const mapping = mappings.find(
      (candidate) => candidate.sourceOffsets[0] === source.indexOf(expression),
    );

    expect(mapping).toMatchObject({
      sourceOffsets: [source.indexOf(expression)],
      generatedOffsets: [generated.indexOf(expression)],
      lengths: [expression.length],
    });
  });

  it("uses the nearest package.json host and Astro strictness", () => {
    const astroFile = `${process.cwd()}/src/fixtures/astro-policy/card.mx`;
    const solidFile = `${process.cwd()}/src/fixtures/solid-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const astroSource = "<let/count=0/>";
    const solidSource = "<button title=count>count</button>";
    const astroVirtual = plugin.createVirtualCode?.(
      astroFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(astroSource),
      { getAssociatedScript: () => undefined },
    );
    const solidVirtual = plugin.createVirtualCode?.(
      solidFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(solidSource),
      { getAssociatedScript: () => undefined },
    );

    expect(astroVirtual?.snapshot.getLength()).toBe(0);
    expect(plugin.getSyntaxError(astroFile)?.message).toContain(
      "strict policy",
    );
    expect(
      solidVirtual?.snapshot.getText(0, solidVirtual.snapshot.getLength()),
    ).toContain("<button title={count}>count</button>");
  });

  it("reports an MX compile error once through tsserver diagnostics", () => {
    const fileName = "/project/broken.mx";
    const consumer = "/project/index.ts";
    const source = "<await=value>oops</await>";
    const service = createPluginService(
      {
        [fileName]: source,
        [consumer]: 'import "./broken.mx";\n',
      },
      [consumer],
    );

    service.getSemanticDiagnostics(consumer);
    const diagnostics = service.getSyntacticDiagnostics(fileName);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      start: source.indexOf("<await"),
      source: "mx",
      code: 80001,
      category: ts.DiagnosticCategory.Error,
    });
  });

  it("maps a type error amid other text to its source expression column", () => {
    const component = "/project/Column.mx";
    const consumer = "/project/index.ts";
    const expression = 'input.count + "x"';
    const source = [
      "export interface Input { count: number }",
      "static function needsNumber(value: number) { return value; }",
      `<p>before ${"${"}needsNumber(${expression})} after</p>`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./Column.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostic = service
      .getSemanticDiagnostics(component)
      .find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });
});

function createPluginService(
  files: Record<string, string>,
  rootFiles: string[],
): ts.LanguageService {
  const snapshots = new Map(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      ts.ScriptSnapshot.fromString(source),
    ]),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: () => "0",
    getScriptKind: (fileName) =>
      fileName.endsWith(".solid.mx")
        ? ts.ScriptKind.TSX
        : fileName.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS,
    getScriptSnapshot(fileName) {
      return (
        snapshots.get(fileName) ??
        (ts.sys.fileExists(fileName)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "")
          : undefined)
      );
    },
    getCurrentDirectory: () => "/project",
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) =>
      snapshots.has(fileName) || ts.sys.fileExists(fileName),
    readFile(fileName) {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? snapshot.getText(0, snapshot.getLength())
        : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (directory) =>
      directory === "/project" || ts.sys.directoryExists(directory),
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((moduleLiteral) => ({
        resolvedModule: ts.resolveModuleName(
          moduleLiteral.text,
          containingFile,
          options,
          host,
        ).resolvedModule,
      }));
    },
  };
  const languageService = ts.createLanguageService(host);
  const project = {
    projectKind: ts.server.ProjectKind.Configured,
    getProjectName: () => "/project/tsconfig.json",
    getCurrentDirectory: () => "/project",
    getScriptVersion: () => "0",
    getScriptInfo: (fileName: string) => {
      const snapshot = snapshots.get(fileName);
      return snapshot ? { getSnapshot: () => snapshot } : undefined;
    },
    readFile: host.readFile,
    fileExists: host.fileExists,
    readDirectory: host.readDirectory,
    useCaseSensitiveFileNames: () => true,
    refreshDiagnostics: () => undefined,
    getCanonicalFileName: (fileName: string) => fileName,
    getModuleResolutionCache: () => undefined,
    projectService: {
      host: ts.sys,
    },
  };
  const info = {
    project,
    languageService,
    languageServiceHost: host,
    serverHost: ts.sys,
    config: {},
    session: { change: () => undefined },
  } as unknown as ts.server.PluginCreateInfo;

  return pluginFactory({ typescript: ts }).create(info);
}
