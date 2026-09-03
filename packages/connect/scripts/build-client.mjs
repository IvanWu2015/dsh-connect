/**
 * Build the dsh-connect client settings bundle.
 *
 * The `dsh web` host discovers a package's settings pane by its `dsh.client`
 * manifest + `exports["./client"]`, and serves the *built bundle* verbatim at
 * `/plugins/<id>/client.js` (see `@deepseek-ai/dsh-client-modules/lib/index.js`
 * `serveBundle`). That bundle must be a classic script whose top-level call
 * registers a plugin factory with the module system:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * We bundle `client/settings-client.mjs` with esbuild (inlining the relative
 * `lib/settings/*` helpers, externalizing `react` so the pane shares the shell's
 * React and hooks work), then wrap the CJS output in that factory shape. The
 * esbuild `banner`/`footer` put the wrapper on the same bundle so the sourcemap
 * stays aligned.
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = resolve(pkgRoot, "client/settings-client.mjs");
const outFile = resolve(pkgRoot, "client/client.js");

const banner = [
  "window.__ModuleLoader__.load({",
  '  id: "dsh-connect",',
  "  factory: (require) => {",
  "    var module = { exports: {} };",
  "    var exports = module.exports;",
].join("\n");
const footer = ["    return module.exports;", "  }", "});"].join("\n");

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["react"],
  banner: { js: banner },
  footer: { js: footer },
  sourcemap: true,
  logLevel: "info",
});

// echo the top of the bundle so a reviewer can eyeball the wrapper
const head = (await readFile(outFile, "utf8")).split("\n").slice(0, 8).join("\n");
console.log(`wrote client/client.js (+ client/client.js.map)`);
console.log("\n--- bundle head ---\n" + head);
