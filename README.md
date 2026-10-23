# Folio

AUGUR's first pillar app: libraries of documents on every floor (your own, a team's, the org's), kept in folders, then published for people to read. It is built only on the public app contract, like any other app.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists Folio: its route, menu, floors and the storage it keeps |
| `frontend/` | The micro frontend the shell mounts at `/folio` (`@apps/folio-frontend`) |
| `service/` | Folio's API, reached through the gateway at `/api/folio` (`@apps/folio`) |

Run it in a stand-in shell with `pnpm dev:app folio`. Without `DATABASE_URL` the service keeps everything in memory; give it its own schema as in [App storage](../../docs/app-storage.md) to keep it.

## Who can do what

A library belongs to the floor it was made on, and is seen only there.

| | Anyone on the floor | The floor's leads |
| --- | --- | --- |
| See its libraries and folders | yes | yes |
| Make a folder | yes | yes |
| Rename or remove a folder | the ones they made | any |
| Make, rename or archive a library | | yes |

On your own floor you are its lead. A folder can be removed only once it is empty; archiving a library takes it off the floor's list and deletes nothing.

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
