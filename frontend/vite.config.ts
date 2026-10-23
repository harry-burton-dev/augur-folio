import { isSharedModule } from '@augur/mfe-sdk/build';
import { defineConfig } from 'vitest/config';

// One ES module at dist/entry.js: the registry's entry URL for Folio. The kit
// and Lit stay external; the shell serves them to every app through its import map.
export default defineConfig({
  build: {
    lib: { entry: 'src/entry.ts', formats: ['es'], fileName: () => 'entry.js' },
    target: 'es2022',
    rollupOptions: { external: isSharedModule },
  },
  test: { environment: 'happy-dom' },
});
