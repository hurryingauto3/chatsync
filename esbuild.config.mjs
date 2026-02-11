import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: [
    "vscode",
  ],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
};

function copyWasmFile() {
  const src = path.join("node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const dest = path.join("dist", "sql-wasm.wasm");
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist", { recursive: true });
  }
  fs.copyFileSync(src, dest);
  console.log("Copied sql-wasm.wasm to dist/");
}

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    copyWasmFile();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    copyWasmFile();
    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
