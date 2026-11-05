---
'@apps/folio': minor
---

Artifacts starts with the service kit's app-service starter: errors are problem details, the floor check and the audit, notification and people adapters come from the kit, named from the manifest. Its late-issue reminders, publication moves and clear-out of deleted documents run as scheduled jobs (once per tick across instances, recorded in the audit log), and renditions are handed to the worker as jobs on DBOS.
