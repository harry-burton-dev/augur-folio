---
'@apps/folio': patch
---

Artifacts keeps its own entry in the Backstage catalog, `catalog-info.yaml`, written by `augur-app catalog` from the manifest and the package.json files. CI checks it is current, and Version packages rewrites it.
