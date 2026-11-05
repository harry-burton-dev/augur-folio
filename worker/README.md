# Folio's rendition worker

Makes each version's renditions after it is uploaded: a reader copy in Markdown and the pictures it shows, a thumbnail of a PDF's first page, and the file's words as plain text. It is Python because [Docling](https://github.com/docling-project/docling), which reads PDF, Word, HTML and Markdown into one document model, is. Plain text has nothing to find and becomes Markdown as written.

| Path | What it is |
| --- | --- |
| `folio_worker/render.py` | A file in, its renditions out |
| `folio_worker/worker.py` | The `renditions` workflow and its steps, run by [DBOS](https://docs.dbos.dev/python/programming-guide) |
| `folio_worker/rows.py` | What each step records in `folio.renditions` |
| `Dockerfile` | Its image, with Docling's models inside so it fetches nothing at run time |
| `requirements.lock` | Every package it installs, Torch and Transformers included, at an exact version with hashes: the image and CI install from it, and OSV-Scanner reads it. After changing `pyproject.toml`, run `worker/lock.sh` (needs download.pytorch.org) or Actions → Lockfile |

## How it works

Folio's service owns the schema and the queue. When a version is saved it adds a `queued` row to `folio.renditions`, the record people see, and queues a run of the DBOS workflow `renditions` on the queue `folio.renditions`, with one argument in DBOS's portable JSON: `{"version": "<version id>"}`. Each run has its own id (`renditions-<version>-<n>`), so a version asked for again gets a new one. The worker listens to that queue only; DBOS hands each run to one worker, so any number can run side by side, and the queue lets each take one run at a time. It keeps where each run got to in Folio's database, in the schema `folio_jobs`, and a worker that stops mid-file carries on from the step it was in when it, or another worker, starts again.

A run has three steps, each safe to run twice:

1. **Start** marks the row `running` and finds the original. A row that's `ready` or `failed` already, or gone with its version, ends the run there.
2. **Render** counts a try (`attempts`), fetches the original from Folio's bucket, renders it, and puts the results under `renditions/<version>/` in the bucket: `reader.md`, `images/<n>.png` and `thumbnail.png`. The reader copy refers to its pictures as `images/1.png`, which Folio's service serves at `…/versions/:n/reader/images/1.png`.
3. **Finish** records the text, page count, keys and what made it (`docling` and its version) and marks the row `ready`; or **fail** marks it `failed`, saying why.

A file Docling can't read, or reads only part of, fails at once with why. Anything else (the bucket down, say) puts the row back to `queued`, saying it will try again, and DBOS tries the render again after a minute, then four; after the third try it fails. Every try counts in `attempts`, a try cut short by a crash too.

The worker's DBOS application version is `augur-jobs-1` (`JOBS_VERSION` in `worker.py`). It must equal the service kit's, or the worker won't take the runs the service queues.

## Settings

The same as Folio's service, so both read one set of storage settings ([App storage](https://github.com/harry-burton-dev/augur/blob/main/docs/app-storage.md)).

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Folio's database login, for its tables and its jobs (DBOS) |
| `APP_ID` | Default `folio`: DBOS's application name, and with `_jobs` the schema its jobs are kept in |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Folio's bucket |
| `S3_REGION` | Default `garage` |
| `RENDER_TIMEOUT_SECONDS` | The longest one file may take. Default 1200 |

## Develop

```sh
python3.12 -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements.lock && pip install --no-deps -e ".[test]" && pip install pytest
pytest                                    # without Postgres, the workflow's tests skip
DATABASE_URL=postgres://… pnpm --filter @apps/folio migrate && DATABASE_URL=postgres://… pytest
RUN_PDF_TESTS=1 pytest                    # PDFs need Docling's models, fetched the first time
```

The workflow's tests launch DBOS against that database, with its jobs in a schema of their own (`folio_worker_test_jobs`) that they make and drop, so their login needs to be able to make a schema.

Under `pnpm dev:app folio` there is no worker; `docker compose -f infra/docker-compose.yml up folio-worker` runs it against the local stack.
