import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveHostPolicy } from "./host-policy.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/host-policy");

/**
 * One set of branch tests for the resolver, living with the resolver itself.
 * Both `@mxlang/language-server` and `@mxlang/typescript-plugin` call this
 * function, and an editor and a `tsc` run disagreeing about which host owns a
 * file is the drift a second copy of these cases would invite.
 */
describe("resolveHostPolicy", () => {
  it("uses the package.json#mxlang field when present, walking up past a subdirectory with no package.json of its own", () => {
    const filePath = join(FIXTURES, "explicit-field/nested/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "astro",
      strict: true,
    });
  });

  it("falls back to the sole @mxlang/* host dependency when no #mxlang field is present", () => {
    const filePath = join(FIXTURES, "single-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("resolves @mxlang/solid as the Solid host dependency", () => {
    const filePath = join(FIXTURES, "solid-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "solid" });
  });

  it("falls back to the html default policy when neither signal is present", () => {
    const filePath = join(FIXTURES, "no-signal/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("accepts 'translator' as a deprecated alias for 'html' and warns", () => {
    const filePath = join(FIXTURES, "deprecated-alias/App.mx");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: The 'translator' mxlang.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
    );

    warnSpy.mockRestore();
  });

  it("resolves the Preact host from a lone @mxlang/preact dependency", () => {
    const filePath = join(FIXTURES, "preact-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "preact" });
  });

  it("falls back to the default policy when two host dependencies are present", () => {
    // Ambiguous on purpose: a project depending on both hosts has not said
    // which one owns this file, so the dependency signal cannot answer and the
    // default applies. An explicit `mxlang.host` is the way to disambiguate.
    const filePath = join(FIXTURES, "two-dependencies/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("falls back to the default policy when the walk reaches the filesystem root with no package.json", () => {
    // The walk must terminate at the root rather than looping forever on
    // `dirname("/") === "/"`. A path with no `package.json` anywhere above it
    // is the case that proves the stop condition fires.
    expect(resolveHostPolicy("/nonexistent-mx-root/App.mx")).toEqual({
      host: "html",
    });
  });
});
