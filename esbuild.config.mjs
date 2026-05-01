import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// PROJECT_VIEWER_DEBUG=1 turns on the diagnostics subsystem. Default off so
// `npm run build` produces a clean production bundle. The constant is
// injected via esbuild `define` so `if (__DEBUG__) { … }` becomes
// `if (false) { … }` in prod and the diagnostics imports inside that
// branch become tree-shakeable.
const debug = process.env.PROJECT_VIEWER_DEBUG === '1';

const define = {
  __DEBUG__: debug ? 'true' : 'false',
};

// Prod needs syntax-level DCE so esbuild actually drops `if (false) { … }`
// blocks (without it, the body — including diagnostic strings and emit
// calls — survives in the bundle, just unreachable). `minifySyntax`
// touches syntax only: no identifier renaming, sourcemaps stay clean.
// Skip in debug builds to keep the output verbatim with the source.
const minifySyntax = !debug;

const extensionCfg = {
  entryPoints: ['src/vscode_extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  define,
  minifySyntax,
};

const webviewCfg = {
  entryPoints: ['src/vscode_extension/webview.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  define,
  minifySyntax,
};

// Dev-only replay tool. Imports the renderer's exported pipeline steps
// (buildElkGraph, runElk, readElkResult, emitSvg) and prints each
// intermediate for a given model.json. Not part of the extension package
// — built alongside it for convenience so `npm run replay …` works after
// any normal build.
const replayCfg = {
  entryPoints: ['scripts/replay.ts'],
  bundle: true,
  outfile: 'dist/replay.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  define,
};

if (watch) {
  const ext = await esbuild.context(extensionCfg);
  const web = await esbuild.context(webviewCfg);
  const rep = await esbuild.context(replayCfg);
  await Promise.all([ext.watch(), web.watch(), rep.watch()]);
  console.log(`watching… (debug=${debug})`);
} else {
  await Promise.all([
    esbuild.build(extensionCfg),
    esbuild.build(webviewCfg),
    esbuild.build(replayCfg),
  ]);
  console.log(`built (debug=${debug})`);
}
