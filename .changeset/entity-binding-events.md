---
'@apps/folio': minor
---

Artifacts tells other apps when a library, folder or document is linked to an entity in Data Atlas, or unlinked from it: `folio.record.entity-bound` and `folio.record.entity-unbound`, from the outbox in the same transaction as the link. Data Atlas uses them for an entity's "Used by".
