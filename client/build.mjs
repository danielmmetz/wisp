// Builds the wisp client and writes outputs into ../cmd/wisp/web/ where the
// Go binary embeds them via embed.FS.
//   node build.mjs           # one-shot build
//   node build.mjs --watch   # watch mode
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// OUT_DIR overrides the default output location, useful in CI/Docker where
// the parent directory may not exist alongside this client folder.
const outDir = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve(__dirname, "../cmd/wisp/web");
const watch = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  for (const name of ["index.html", "style.css"]) {
    await cp(path.join(__dirname, "public", name), path.join(outDir, name));
  }
  // DeepFilterNet3 assets — fetched at runtime by the package's AssetLoader,
  // which expects {cdnUrl}/v2/pkg/df_bg.wasm and
  // {cdnUrl}/v2/models/DeepFilterNet3_onnx.tar.gz. We vendor them under
  // public/dfn/ and serve from the same origin.
  await cp(path.join(__dirname, "public/dfn"), path.join(outDir, "dfn"), {
    recursive: true,
  });
}

const buildOpts = {
  entryPoints: [path.join(__dirname, "src/main.ts")],
  outfile: path.join(outDir, "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: !watch ? "linked" : "inline",
  minify: !watch,
  legalComments: "linked",
  logLevel: "info",
};

if (watch) {
  await copyStatic();
  const ctx = await context(buildOpts);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await rm(outDir, { recursive: true, force: true });
  await copyStatic();
  await build(buildOpts);
}
