---
'@apps/folio': patch
---

The service stays up when Postgres restarts or drops an idle connection: its database pools log the lost connection (the service kit's `steadyPool`) instead of ending the process (PER-207).
