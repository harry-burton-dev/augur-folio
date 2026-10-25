# Folio

AUGUR's first pillar app: libraries of documents on every floor (your own, a team's, the org's), kept in folders, then published for people to read. It is built only on the public app contract, like any other app.

Folio keeps every file exactly as it was uploaded, as numbered versions in its own bucket, with its size and SHA-256. It takes PDF, Word (.docx), HTML, Markdown and plain text, up to 200 MB each; uploads stream straight through to the bucket.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists Folio: its route, menu, floors and the storage it keeps |
| `frontend/` | The micro frontend the shell mounts at `/folio` (`@apps/folio-frontend`) |
| `service/` | Folio's API, reached through the gateway at `/api/folio` (`@apps/folio`) |
| `worker/` | The rendition worker, in Python: makes each version's reader copy with Docling ([its README](worker/README.md)) |

Run it in a stand-in shell with `pnpm dev:app folio`. Without `DATABASE_URL` and the `S3_*` settings the service keeps everything in memory; give it its own schema and bucket as in [App storage](../../docs/app-storage.md) to keep it. In production it won't start without both.

## Who can do what

A library belongs to the floor it was made on. Everyone who can stand on that floor can read it, from wherever they are: on a team's floor that's its members and those of the teams below it, on the org's everyone, and on your own floor only you. Standing on its floor, they can add to it too, and the floor's leads manage it. Anyone else sees a library or a document only once it has been shared with them.

Whoever manages a library can share it, or one document in it, with a person, a team, a team and the teams below it, or the whole org, and say how far: **read** (read it, download the original), **edit** (also add documents and folders, and change any document; for one document, add versions, retitle and tag it), or **manage** (also share it, and for a library rename and archive it). What's shared appears under "Shared with you" on every floor of theirs. Anyone who can see something can see who else can.

| | Can read | On its floor, or can edit | Can manage (the floor's leads) |
| --- | --- | --- | --- |
| See the library, its folders and documents | yes | yes | yes |
| Download any version's original; read its reader copy | yes | yes | yes |
| See who else can see it | yes | yes | yes |
| Make a folder, upload a document, save a view | | yes | yes |
| Rename or remove a folder | | the ones they made (any, with edit) | any |
| Add a version, retitle, move, tag or delete a document; ask again for a failed reader copy | | the ones they added (any, with edit) | any |
| Add a tag to the library | | when it takes free tags | yes |
| Share it, rename or archive it, keep its tags, rename or delete anyone's views | | | yes |

Folio asks identity who each person stands for (`people:read`): `person:<id>`, `team:<id>` for each team they're on, `tree:<id>` for each of those teams and every team above it, and `org`. Each document's readers (its library's floor and everyone let in) are written down in `folio.readers`, and lists keep to what overlaps. While identity can't be asked, Folio lets nothing through. Under `pnpm dev:app` there's no identity: you stand for yourself, the floor you're on and the org, and you can share with the people Folio has seen.

## Publishing

Whoever manages a document can publish one of its versions to an audience: a team, a team and the teams below it, or the whole org. Everyone in the audience can then read that version, and only that one, from their own floor, even if they can't see the library: it's under "Published to you", and each of them is told, with a **Read** button that opens it. Publishing a document again puts the new version out in place of the old one; withdrawing it takes it back, with a reason if there is one. Every time it was published stays on the record.

A team's leads publish to their team and the teams below it, and the org's leads to any team. Publishing to the whole org, to teams beyond the floor, or from your own floor needs the **publisher** role, which an admin gives in Admin, People. To let one person in, share the document with them instead.

Documents are drafts until they're published, and the list can be narrowed to drafts, published or withdrawn ones.

Folio tells other apps what happened through the platform's events (`events:publish`), from an outbox in its own schema, so an event goes out if and only if the change it tells of was saved: `folio.document.version.created`, `folio.document.published`, `folio.document.withdrawn`, `folio.document.deleted` and `folio.document.readers.changed`. They carry ids only, never titles or text. It handles `document.open`: another app opens one of Folio's documents with `openDocument(ctx, ref)`.

A folder can be removed only once it is empty; archiving a library takes it off the floor's list and deletes nothing, and deleting a document takes it out of its library but keeps its files.

## Tags, filters and views

Each library has its own tags, and the org has tags every library shares (such as Policy or Finance). The org's tags are kept by the leads on the org's floor. A library's tag can't take an org tag's name, and a new org tag takes in the libraries' tags of its name: their documents and saved views carry the org's tag from then on. Removing a tag takes it off every document and view that had it.

The list can be narrowed by tags (all of those chosen), file type, who added it and when it last changed, and sorted by title, newest or most recently changed. Once a filter is on, the list looks in every folder below where you are. A set of filters can be saved as a view, which goes in the library's side rail for everyone there; "the past month" stays the past month, not the month it was saved.

## Reader copies

Every version gets a reader copy: the rendition worker turns its file into Markdown with [Docling](https://github.com/docling-project/docling), with the pictures it shows, a thumbnail of a PDF's first page, and its words as plain text for search. The original stays as it was; the reader copy is what Folio shows people to read. Each version says how its copy is coming along (`reader.state`: queued, running, ready or failed). A file Docling can't read fails at once with why; anything else (the bucket down, say) is tried again after a minute, then four, then sixteen, and then fails. Whoever may change the document can ask for a failed copy again.

The worker leases one version at a time from Folio's `renditions` table, so any number can run side by side, and hears of new versions straight away (Postgres `LISTEN`). Under `pnpm dev:app` there's no worker: Markdown and plain text are their own reader copies, and other files say the worker isn't running.

## Reading

Opening a document opens its reader page: the reader copy as a page of text, set in the kit's type and the floor's colours, light or dark. Its headings make the contents down the side, which follow along as you read and take you to a heading in one press. Every heading and paragraph has a stable anchor (`#claims`, `#b12`), so a link can point into a document. The text can be made smaller or larger, and the page wide or narrow; Folio remembers that for you, on that browser. It also remembers where you got to in each version and takes you back there next time. The side panel has the document's versions (an older one says so, with a way to the newest), its tags, and "Download the original" one press away. Until a version's reader copy is ready, the page says it's being made; if it failed, it says why, and whoever may change the document can try again.

## On the record

Folio writes to the platform's audit log (the `audit:write` scope): a library made or archived, a document uploaded, a version added, a document deleted, published or withdrawn, every change to who it's shared with, and every download of an original. A download is given only once it is on the record: while the audit log can't be reached, downloads wait.

## API

All under `/api/folio/v1`, sent with the floor's `X-Workspace-Id` (`ctx.fetch` adds it).

| | |
| --- | --- |
| `GET /libraries` | The floor's libraries, and whether the caller can make one |
| `POST /libraries` `{name, description?}` | A new library (the floor's leads) |
| `GET /libraries/:id` | A library with its folders, tags (the org's and its own), authors, saved views, and what the caller may do there |
| `PATCH /libraries/:id` `{name?, description?, freeTags?}` | Rename or describe it, or let anyone add tags (leads) |
| `POST /libraries/:id/archive` | Take it off the floor's list (leads) |
| `POST /libraries/:id/folders` `{name, parent?}` | A new folder, at the top or inside another, at most 6 deep |
| `PATCH /libraries/:id/folders/:folder` `{name}` | Rename a folder |
| `DELETE /libraries/:id/folders/:folder` | Remove an empty folder |
| `GET /libraries/:id/documents?folder=&below=&tag=&type=&author=&since=&from=&to=&state=&sort=&limit=&offset=` | The documents in a folder (or at the top), or with `below=true` everything inside it, filtered and sorted, with the `total`. `tag`, `type`, `author` and `state` repeat; `type` is pdf, word, html, markdown or text; `since` is week, month, quarter or year; `state` is draft, published or withdrawn; `sort` is title, newest or updated |
| `POST /libraries/:id/documents?filename=&title=&folder=&tag=` | Upload a document: the body is the file, its `Content-Type` its type; `tag` repeats |
| `PUT /libraries/:id/documents/:doc/tags` `{tags}` | Give a document exactly these tags |
| `GET /libraries/:id/documents/:doc` | A document with its versions, newest first, its `state` and what's `published`. To its audience alone: only the version that's out, as `only` |
| `PATCH /libraries/:id/documents/:doc` `{title?, folder?}` | Retitle it, or move it (`folder: null` is the top) |
| `DELETE /libraries/:id/documents/:doc` | Take it out of the library |
| `POST /libraries/:id/documents/:doc/versions?filename=` | Its next version, sent as above |
| `GET /libraries/:id/documents/:doc/versions/:n/original` | Version n's file as it was uploaded |
| `GET /libraries/:id/documents/:doc/versions/:n/reader` | Its reader copy, as Markdown (409 `not-ready` until it's made) |
| `GET /libraries/:id/documents/:doc/versions/:n/reader/images/:name` | A picture the reader copy shows (`images/1.png`) |
| `GET /libraries/:id/documents/:doc/versions/:n/thumbnail`, `…/text` | Its first page as a PNG (PDFs), and its words as plain text |
| `POST /libraries/:id/documents/:doc/versions/:n/reader/retry` | Ask again for a reader copy that failed |
| `GET /libraries/:id/access`, `GET /libraries/:id/documents/:doc/access` | Who may see it: its floor, who has been let in (for a document, into it and into its library), and whether the caller may share it |
| `PUT /libraries/:id/access/:principal` `{level}`, `DELETE …` | Let a person or team into the library that far (read, edit or manage), or take them out (managers). `:principal` is `person:<id>`, `team:<id>`, `tree:<id>` or `org` |
| `PUT /libraries/:id/documents/:doc/access/:principal` `{level}`, `DELETE …` | The same for one document (whoever manages it) |
| `GET /people?q=` | People and teams to share with, by name |
| `GET /shared` | Libraries and documents shared with the caller from other floors |
| `POST /libraries/:id/documents/:doc/publish` `{version, audience, note?}` | Put a version out to `audience` (`team:<id>`, `tree:<id>` or `org`), in place of what was out, and tell them (whoever manages it) |
| `POST /libraries/:id/documents/:doc/withdraw` `{reason?}` | Take back what's out (whoever manages it) |
| `GET /libraries/:id/documents/:doc/publications` | Every time it was published, newest first, with its audience named, and whether the caller may publish it, and to the org |
| `GET /published?limit=&offset=` | What's out to the caller now, from any floor, newest first |
| `GET /documents/:doc` | Where a document is (`{id, library, title}`), for `document.open`, which gives only its id |
| `GET /tags` | The org's tags, and whether the caller keeps them |
| `POST /tags` `{name}`, `PATCH /tags/:tag` `{name}`, `DELETE /tags/:tag` | Keep the org's tags (leads on the org's floor) |
| `POST /libraries/:id/tags` `{name}` | A tag for the library (leads, or anyone when it takes free tags) |
| `PATCH /libraries/:id/tags/:tag` `{name}`, `DELETE /libraries/:id/tags/:tag` | Rename or remove one of its tags (leads) |
| `POST /libraries/:id/views` `{name, query}` | Save a view: `query` is `{folder?, tags?, types?, authors?, since?, sort?, states?}` |
| `PATCH /libraries/:id/views/:view` `{name?, query?}`, `DELETE /libraries/:id/views/:view` | Change or delete a view (whoever saved it, or leads) |
