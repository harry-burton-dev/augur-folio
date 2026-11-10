import { isSharedModule } from '@augur/mfe-sdk/build';
import { defineConfig, type Plugin } from 'vitest/config';
import manifest from '../manifest.json';

// One ES module, the manifest's `frontend.entry` (dist/sandbox.js), which the shell serves from
// /apps/<id>/<version>/ and runs in a web worker of the app's own: no DOM, no network, no token. The
// worker has no import map, so everything the entry imports is bundled into it, and React and the
// kits, which only the shell's page has, can't be imported at all: the app draws Quill's remote
// elements by name instead (`@augur/app-kit/remote` has their props, as types).
const pageOnly = (): Plugin => ({
  name: 'page-only-modules',
  enforce: 'pre',
  resolveId(id) {
    if (isSharedModule(id)) {
      this.error(`${id} is only on the shell's page, and ${manifest.name}'s frontend runs in a worker: draw Quill's remote elements by name (\`@augur/app-kit/remote\`).`);
    }
  },
});

export default defineConfig({
  plugins: [pageOnly()],
  build: {
    lib: { entry: 'src/entry.ts', formats: ['es'], fileName: () => manifest.frontend.entry },
    target: 'es2022',
  },
  test: { environment: 'node' },
});
