const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    format: "cjs",
    platform: "node",
    external: ["vscode"],
    sourcemap: true,
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("[esbuild] Built dist/extension.js");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
