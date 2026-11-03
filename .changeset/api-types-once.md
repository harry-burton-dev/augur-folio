---
'@apps/folio-frontend': patch
'@apps/folio': patch
---

The wire types between the frontend and the service are written once, in the service's src/api-types.ts, and both sides use them. Types only: the frontend bundle and the service build don't change.
