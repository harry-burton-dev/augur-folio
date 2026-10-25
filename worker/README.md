# Folio's rendition worker

Makes each version's renditions after it is uploaded: a reader copy in Markdown and the pictures it shows, a thumbnail of a PDF's first page, and the file's words as plain text. It is Python because [Docling](https://github.com/docling-project/docling), which reads PDF, Word, HTML and Markdown into one document model, is. Plain text has nothing to find and becomes Markdown as written.

| Path | What it is |
| --- | --- |
| `folio_worker/render.py` | A file in, its renditions out |
| `folio_worker/queue.py` | Leasing, finishing and failing rows of `folio.renditions` |
| `folio_worker/worker.py` | The loop: everything waiting, then wait for word of more |
| `Dockerfile` | Its image, with Docling's models inside so it fetches nothing at run time |

## How it works

Folio's service owns the schema. When a version is saved it adds a `queued` row to `folio.renditions` and says so on the `folio_renditions` channel. The worker leases the row that has waited longest (`for update skip locked`, so several workers never take the same one), fetches the original from Folio's bucket, renders it, and puts the results under `renditions/<version>/` in the bucket: `reader.md`, `images/<n>.png` and `thumbnail.png`. The reader copy refers to its pictures as `images/1.png`, which Folio's service serves at `…/versions/:n/reader/images/1.png`. The text, page count and what made it (`docling` and its version) go in the row.

Each lease counts as an attempt and lasts the render timeout plus five minutes. A file Docling can't read, or reads only part of, fails at once with why. Anything else goes back in the queue for later (a minute, four, sixteen) and fails after three tries. A worker that dies mid-file lets its lease run out and the next worker takes the row; a result that comes back after its lease was taken is dropped.

## Settings

The same as Folio's service, so both read one set of storage settings ([App storage](../../../docs/app-storage.md)).

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Folio's database login |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Folio's bucket |
| `S3_REGION` | Default `garage` |
| `RENDER_TIMEOUT_SECONDS` | The longest one file may take. Default 1200 |
| `POLL_SECONDS` | How often it looks for retries that came due. Default 30 |

## Develop

```sh
python3.12 -m venv .venv && . .venv/bin/activate
pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[test]"
pytest                                    # without Postgres, the queue's tests skip
DATABASE_URL=postgres://… pnpm --filter @apps/folio migrate && DATABASE_URL=postgres://… pytest
RUN_PDF_TESTS=1 pytest                    # PDFs need Docling's models, fetched the first time
```

Under `pnpm dev:app folio` there is no worker; `docker compose -f infra/docker-compose.yml up folio-worker` runs it against the local stack.
