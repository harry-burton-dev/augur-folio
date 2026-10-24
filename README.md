# Folio

AUGUR's first pillar app: libraries of documents on every floor (your own, a team's, the org's), kept in folders, then published for people to read. It is built only on the public app contract, like any other app.

Folio keeps every file exactly as it was uploaded, as numbered versions in its own bucket, with its size and SHA-256. It takes PDF, Word (.docx), HTML, Markdown and plain text, up to 200 MB each; uploads stream straight through to the bucket.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists Folio: its route, menu, floors and the storage it keeps |
| `frontend/` | The micro frontend the shell mounts at `/folio` (`@apps/folio-frontend`) |
| `service/` | Folio's API, reached through the gateway at `/api/folio` (`@apps/folio`) |

Run it in a stand-in shell with `pnpm dev:app folio`. Without `DATABASE_URL` and the `S3_*` settings the service keeps everything in memory; give it its own schema and bucket as in [App storage](../../docs/app-storage.md) to keep it. In production it won't start without both.

## Who can do what

A library belongs to the floor it was made on, and is seen only there.

| | Anyone on the floor | The floor's leads |
| --- | --- | --- |
| See its libraries and folders | yes | yes |
| Make a folder | yes | yes |
| Rename or remove a folder | the ones they made | any |
| Make, rename or archive a library | | yes |
| Upload a document | yes | yes |
| Add a version, retitle, move or delete a document | the ones they added | any |
| Download any version's original | yes | yes |

On your own floor you are its lead. A folder can be removed only once it is empty; archiving a library takes it off the floor's list and deletes nothing, and deleting a document takes it out of its library but keeps its files.

## On the record

Folio writes to the platform's audit log (the `audit:write` scope): a library made or archived, a document uploaded, a version added, a document deleted, and every download of an original. A download is given only once it is on the record: while the audit log can't be reached, downloads wait.

## API

All under `/api/folio/v1`, sent with the floor's `X-Workspace-Id` (`ctx.fetch` adds it).

| | |
| --- | --- |
| `GET /libraries` | The floor's libraries, and whether the caller can make one |
| `POST /libraries` `{name, description?}` | A new library (leads) |
| `GET /libraries/:id` | A library with its folders and what the caller may do there |
| `PATCH /libraries/:id` `{name?, description?}` | Rename or describe it (leads) |
| `POST /libraries/:id/archive` | Take it off the floor's list (leads) |
| `POST /libraries/:id/folders` `{name, parent?}` | A new folder, at the top or inside another, at most 6 deep |
| `PATCH /libraries/:id/folders/:folder` `{name}` | Rename a folder |
| `DELETE /libraries/:id/folders/:folder` | Remove an empty folder |
| `GET /libraries/:id/documents?folder=` | The documents in a folder, or at the top without one |
| `POST /libraries/:id/documents?filename=&title=&folder=` | Upload a document: the body is the file, its `Content-Type` its type |
| `GET /libraries/:id/documents/:doc` | A document with its versions, newest first |
| `PATCH /libraries/:id/documents/:doc` `{title?, folder?}` | Retitle it, or move it (`folder: null` is the top) |
| `DELETE /libraries/:id/documents/:doc` | Take it out of the library |
| `POST /libraries/:id/documents/:doc/versions?filename=` | Its next version, sent as above |
| `GET /libraries/:id/documents/:doc/versions/:n/original` | Version n's file as it was uploaded |
