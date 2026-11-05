---
'@apps/folio': patch
---

Folio keeps its libraries only in Postgres: its in-memory store is gone, and its tests run on real Postgres. Under `pnpm dev:app` it needs `DATABASE_URL` (the dev stack's Postgres); without a bucket, a stand-in still makes reader copies of Markdown and text.
