// Builds the wisp client and writes outputs into ../cmd/wisp/web/ where the
// Go binary embeds them via embed.FS.
//   node build.mjs           # one-shot build
//   node build.mjs --watch   # watch mode
import { build, context, transform } from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibC, gzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// OUT_DIR overrides the default output location, useful in CI/Docker where
// the parent directory may not exist alongside this client folder.
const outDir = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve(__dirname, "../cmd/wisp/web");
const watch = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await cp(
    path.join(__dirname, "public/favicon.svg"),
    path.join(outDir, "favicon.svg"),
  );
  // Minify style.css and index.html for the embedded build. In watch mode,
  // skip minification so DevTools shows readable source.
  const css = await readFile(path.join(__dirname, "public/style.css"), "utf8");
  const cssOut = watch
    ? css
    : (await transform(css, { loader: "css", minify: true })).code;
  await writeFile(path.join(outDir, "style.css"), cssOut);

  const html = await readFile(
    path.join(__dirname, "public/index.html"),
    "utf8",
  );
  const htmlOut = watch
    ? html
    : await minifyHtml(html, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        useShortDoctype: true,
        minifyCSS: true,
        minifyJS: true,
      });
  await writeFile(path.join(outDir, "index.html"), htmlOut);
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
  await precompress(outDir);
}

// Pre-encode every compressible file in dir to .gz and .br siblings. The Go
// server serves these directly when the client advertises the matching
// encoding, so all compression cost is paid here at build time. Skipped in
// watch mode (dev workflow doesn't care about wire size).
async function precompress(dir) {
  // Already compressed or container formats: no point re-encoding, and for
  // .tar.gz the encoded bytes ARE the payload (we don't want to decode them
  // via Content-Encoding).
  const skipExt = new Set([
    ".gz",
    ".tgz",
    ".br",
    ".zst",
    ".zip",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".gif",
    ".woff",
    ".woff2",
    ".mp3",
    ".mp4",
    ".webm",
    ".ogg",
  ]);
  let totalRaw = 0;
  let totalGz = 0;
  let totalBr = 0;
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (skipExt.has(path.extname(ent.name).toLowerCase())) continue;
      const data = await readFile(full);
      const gz = gzipSync(data, { level: 9 });
      const br = brotliCompressSync(data, {
        params: {
          [zlibC.BROTLI_PARAM_QUALITY]: 11,
          [zlibC.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      totalRaw += data.length;
      // Only keep encoded variants that actually shrink the file.
      if (gz.length < data.length) {
        await writeFile(full + ".gz", gz);
        totalGz += gz.length;
      }
      if (br.length < data.length) {
        await writeFile(full + ".br", br);
        totalBr += br.length;
      }
    }
  }
  await walk(dir);
  const kb = (n) => (n / 1024).toFixed(1) + "kb";
  console.log(
    `  precompressed ${kb(totalRaw)} -> gzip ${kb(totalGz)} / brotli ${kb(totalBr)}`,
  );
}
