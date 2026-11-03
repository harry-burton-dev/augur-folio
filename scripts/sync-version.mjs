// After `changeset version`: the manifest's version is the app's release, taken from its frontend's package
// (or its service's when it has none), as in the AUGUR repository (docs/versioning.md there).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const from = ['frontend/package.json', 'service/package.json'].find((p) => existsSync(p));
const { version } = JSON.parse(readFileSync(from, 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (manifest.version !== version) {
  writeFileSync('manifest.json', `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  console.log(`manifest.json is now ${version}.`);
}
