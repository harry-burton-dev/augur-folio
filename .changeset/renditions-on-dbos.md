---
"@apps/folio": minor
---

The rendition worker runs each reader copy as a durable DBOS workflow, taken from the `folio.renditions` queue the service puts it on, instead of leasing rows of the `renditions` table itself. The table stays the record of how each copy is coming along. The worker keeps its jobs in the `folio_jobs` schema and no longer reads `POLL_SECONDS`. DBOS's Python SDK (`dbos` 3.4.0) is pinned in `worker/requirements.lock` with the worker's other packages. Rows the old worker was still holding go back on the queue the first time the new worker starts.
