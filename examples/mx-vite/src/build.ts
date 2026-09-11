import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import renderAbout from "./pages/about.marko";
import renderHome from "./pages/home.marko";

const outDir = join(import.meta.dirname, "..", "dist");
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "index.html"), renderHome({ name: "world" }));
writeFileSync(join(outDir, "about.html"), renderAbout({}));

console.log("wrote dist/index.html");
console.log("wrote dist/about.html");
