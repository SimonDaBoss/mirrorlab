// Bundles main, preload and renderer with esbuild; copies static renderer files.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const common = { bundle: true, sourcemap: true, logLevel: "warning", target: "es2022" };
await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload/preload.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/mirror.ts", "src/renderer/launcher.ts"], outdir: "dist/renderer", platform: "browser", format: "iife" }),
]);
mkdirSync("dist/renderer", { recursive: true });
for (const f of ["index.html", "mirror.html", "style.css"]) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
console.log("built dist/");
