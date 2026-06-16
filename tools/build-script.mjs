/**
 * build-script.mjs — bundle the DungeonState runtime into ONE file loadable by
 * Tavern Helper's script manager.
 *
 *   node tools/build-script.mjs            # build dist/dungeonstate.js
 *   node tools/build-script.mjs --watch    # rebuild on change
 *
 * Tavern Helper runs a user script inside an iframe and injects several libraries as
 * GLOBALS (see JS-Slash-Runner .../src/iframe/predefine.js): `_` (lodash), `z` (zod),
 * `YAML`, `$`, `toastr`, plus the TavernHelper bound functions. So we must NOT bundle
 * those — we resolve their bare specifiers to tiny virtual modules that re-export the
 * global. `json5` is NOT provided as a global, so it is bundled normally.
 *
 * Output is a single self-contained ES module (the iframe loads scripts as
 * `<script type="module">`), with no residual `import ... from "lodash"` etc.
 */
import esbuild from 'esbuild';

const OUT = 'dist/dungeonstate.js';

/** Map global-backed packages to virtual modules that re-export the injected global. */
const GLOBAL_MODULES = {
  lodash: 'export default globalThis._;',
  zod: 'export const z = globalThis.z; export default globalThis.z;',
  yaml: 'export default globalThis.YAML;',
};

const globalsPlugin = {
  name: 'tavern-globals',
  setup(build) {
    const filter = new RegExp(`^(${Object.keys(GLOBAL_MODULES).join('|')})$`);
    build.onResolve({ filter }, args => ({ path: args.path, namespace: 'tavern-global' }));
    build.onLoad({ filter: /.*/, namespace: 'tavern-global' }, args => ({
      contents: GLOBAL_MODULES[args.path],
      loader: 'js',
    }));
  },
};

const options = {
  entryPoints: ['src/runtime.ts'],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: '// DungeonState — generated bundle. Edit src/ and rerun `npm run build:script`.' },
  plugins: [globalsPlugin],
};

const watch = process.argv.includes('--watch');

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`[build-script] watching… → ${OUT}`);
} else {
  await esbuild.build(options);
  console.log(`[build-script] wrote ${OUT}`);
}
