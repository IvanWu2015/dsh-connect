/**
 * Diagnose why image capability detection may fail at runtime.
 * Loads the real DSH llm runtime + deepseek + pi-ai adapters (from the web
 * profile's node_modules, via absolute import) into a Cordis context and
 * reproduces the exact probing the plugin's `findVisionModel` performs:
 * listProviders -> listModels -> resolveModelInfo.
 *
 * Run:  node packages/connect/test/diagnose-vision.mjs
 */
import { Context } from "@deepseek-ai/cordis";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const NM = join(process.env.USERPROFILE, ".dsh", "profiles", "node_modules");
const url = (name) => pathToFileURL(join(NM, name)).href;

const llmMod = await import(url("@deepseek-ai/dsh-llm/lib/index.js"));
const deepseekMod = await import(url("@deepseek-ai/dsh-llm-deepseek/lib/index.js"));
const piMod = await import(url("@deepseek-ai/dsh-llm-pi-ai/lib/index.js"));

const ctx = new Context();

// Minimal service stubs the llm plugins may touch.
ctx.provide("settings", {});
ctx.provide("credentials", {});
ctx.provide("launchEnvironment", {});

for (const mod of [llmMod, deepseekMod, piMod]) {
  if (typeof mod.apply === "function") {
    try {
      mod.apply(ctx, {});
      console.log(`applied ${mod.name ?? "(unnamed)"}`);
    } catch (e) {
      console.log(`apply ${mod.name ?? "(unnamed)"} failed:`, e?.message ?? e);
    }
  } else {
    console.log(`no apply in module (${Object.keys(mod).slice(0, 8).join(",")})`);
  }
}

await new Promise((r) => setTimeout(r, 300));

const llm = ctx.get("llm");
console.log("\nllm service present:", !!llm);
if (!llm) process.exit(1);

// 1) providers
let providers;
try {
  providers = llm.listProviders();
  console.log("\nlistProviders():", JSON.stringify(providers, null, 2));
} catch (e) {
  console.log("listProviders threw:", e?.message ?? e);
  process.exit(1);
}

// 2) per provider, listModels + resolveModelInfo with inputModalities
for (const p of providers ?? []) {
  let models;
  try {
    models = await llm.listModels(p.id);
    console.log(
      `\nlistModels(${p.id}):`,
      JSON.stringify(models?.map?.((m) => ({ id: m.id, inputModalities: m.inputModalities })) ?? models),
    );
  } catch (e) {
    console.log(`listModels(${p.id}) threw:`, e?.message ?? e);
    continue;
  }
  for (const m of models ?? []) {
    try {
      const info = await llm.resolveModelInfo(p.id, m.id);
      console.log(`resolveModelInfo(${p.id}, ${m.id}) -> inputModalities:`, JSON.stringify(info?.inputModalities));
    } catch (e) {
      console.log(`resolveModelInfo(${p.id}, ${m.id}) threw:`, e?.message ?? e);
    }
  }
}

console.log("\nDONE");
process.exit(0);
