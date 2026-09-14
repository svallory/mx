import { fileURLToPath } from "node:url";
import { build } from "astro";
import { describe, expect, it } from "vitest";
import mxAstro from "./index.ts";

describe("addPageExtension guard", () => {
  it("registers .mx and .amx when addPageExtension is present", () => {
    const integration = mxAstro();
    const setupHook = integration.hooks["astro:config:setup"]!;

    const extensions: string[] = [];
    const addPageExtension = (...exts: (string | string[])[]) => {
      extensions.push(...exts.flat());
    };

    setupHook({
      config: { srcDir: new URL("file:///src/") },
      addRenderer: () => {},
      addPageExtension,
      updateConfig: () => {},
    });

    expect(extensions).toContain(".mx");
    expect(extensions).toContain(".amx");
  });

  it("throws a clear error if addPageExtension is missing", () => {
    const integration = mxAstro();
    const setupHook = integration.hooks["astro:config:setup"]!;

    expect(() => {
      setupHook({
        config: { srcDir: new URL("file:///src/") },
        addRenderer: () => {},
        addPageExtension: undefined,
        updateConfig: () => {},
      });
    }).toThrowError(/Astro .* does not provide the 'addPageExtension' hook/);
  });
});

describe("real Astro hooks integration", () => {
  it("exposes addPageExtension on the real setup hook params", async () => {
    let addPageExtensionType = "missing";

    const testIntegration = {
      name: "test-integration",
      hooks: {
        // biome-ignore lint/suspicious/noExplicitAny: testing dynamic hook presence
        "astro:config:setup": (options: any) => {
          addPageExtensionType = typeof options.addPageExtension;
        },
      },
    };

    // run a real but minimal Astro build to invoke the hook.
    // Astro build needs a root directory
    try {
      await build({
        root: fileURLToPath(
          new URL("../../../examples/astro-static", import.meta.url),
        ),
        integrations: [testIntegration],
        logLevel: "silent", // avoid polluting test output
      });
    } catch (_e) {
      // Astro build might fail if we run it like this, but the hook should have fired.
      // If we don't want to rely on examples/astro-static, we can just do a very minimal build.
    }

    expect(addPageExtensionType).toBe("function");
  });
});
