'use strict';

// ---------------------------------------------------------------------------
// Bundle the content preloads that import shared modules. A sandboxed preload
// can't `require()` a local file at runtime (Electron only allows electron /
// events / timers / url), so esbuild inlines the imports here at build time and
// main.js loads the bundled output from dist/.
//
//   npm run build     one-shot bundle (run by `npm start` before electron)
//   npm run watch     rebuild on change during development
//
// Only preloads that pull in a shared module need bundling; the chrome renderer
// (ui/*.js) keeps loading classic <script>s and shares the same source files via
// a plain global, so it needs no build step.
// ---------------------------------------------------------------------------
const esbuild = require('esbuild');

const options = {
  entryPoints: ['tabPreload.js'], // requires ./ui/scrollbarCore.js
  outdir: 'dist',
  bundle: true,
  platform: 'node',        // CJS preload environment (require stays)
  format: 'cjs',
  target: 'node20',        // Electron 42 ships Node 20+
  external: ['electron'],  // provided by the runtime — never bundle it
  sourcemap: true,         // map bundled preload stack traces back to source
  logLevel: 'info',
};

async function main() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching preloads for changes…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
