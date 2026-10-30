# Folio

People see Folio as **Artifacts**: that's its name in the manifest and in everything it says to them. Folio stays its id, route, schema, bucket, containers and code name.

AUGUR's first pillar app: libraries of documents on every floor (your own, a team's, the org's), given form by levels (collection › subcollection › series › subseries › file), each version moving through a lifecycle, then published for people to read. Its levels, lifecycles and access rules come from `@augur/records` ([App patterns](../../docs/app-patterns.md)). It is built only on the public app contract, like any other app.

Folio keeps every file exactly as it was uploaded, as numbered versions in its own bucket, with its size and SHA-256. It takes PDF, Word (.docx), HTML, Markdown and plain text, up to 200 MB each; uploads stream straight through to the bucket.

This README is for developers. To use Folio, or run it as an admin, see [the Artifacts guide](../../docs/folio.md).

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists Folio: its name, its route, its menu (kept inside it, `"orbit": false`), floors and the storage it keeps |
| `frontend/` | The micro frontend the shell mounts at `/folio` (`@apps/folio-frontend`) |
| `service/` | Folio's API, reached through the gateway at `/api/folio` (`@apps/folio`) |
| `worker/` | The rendition worker, in Python: makes each version's reader copy with Docling ([its README](worker/README.md)) |

Run it in a stand-in shell with `pnpm dev:app folio`. Without `DATABASE_URL` and the `S3_*` settings the service keeps everything in memory; give it its own schema and bucket as in [App storage](../../docs/app-storage.md) to keep it. In production it won't start without both.

## Shipped with AUGUR

Every deployment runs Folio: the platform release builds its images (`folio`, `folio-worker`), serves its frontend from the front door, and pins its version. It's still an ordinary app. It signs in as itself (`app-folio`, from `FOLIO_CLIENT_SECRET`, which identity makes in Keycloak), keeps its own schema and bucket (from `FOLIO_DATABASE_PASSWORD` and `FOLIO_BUCKET_SECRET`, which the storage container sets up), and registers its manifest each time its service starts, so it's in Admin, Apps with no admin step. The registry knows it as one of `PILLAR_APPS`: it gets the scopes each release asks for, its version comes with the release, and an admin can turn it off, org-wide or floor by floor, but not remove it. The contract tests run with Folio on and off (`platform/contract`).

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

## Series

A series is a named run of documents in one library that comes out on a cadence, such as a weekly cash report: weekly, monthly, quarterly, or now and then. It has the tags each issue starts with, and the audience each issue goes to. Whoever manages the library keeps its series; the audience must be one they could publish to.

Each issue is an ordinary document with a number and a period ("Week 43, 2026", "October 2026", "Q4 2026"). Adding the next one takes one file: drop it on the series' page and the series names it ("Cash report: Week 44, 2026"), numbers it, tags it and, when the person adding it may publish to the series' audience, publishes it. Anyone else's issue waits as a draft for whoever manages the library. The next issue is for the period after the last one, but never more than one period behind now, so a series picked up after a break carries on from last period. Periods are in UTC.

Its library's readers and its audience can follow a series, to be told of each issue that's published to them, with a **Read** button; an issue goes only to the followers in its audience, not to everyone in it. When an issue is late (a day after a week ends, three after a month, seven after a quarter), the series' owner, who made it, is told once. The reader shows where an issue comes in its series, with the issues either side that the person may read.

A series with no issues can be removed; one with issues stays, so its issues keep their place.

## Tags, filters and views

Each library has its own tags, and the org has tags every library shares (such as Policy or Finance). The org's tags are kept by the leads on the org's floor. A library's tag can't take an org tag's name, and a new org tag takes in the libraries' tags of its name: their documents and saved views carry the org's tag from then on. Removing a tag takes it off every document and view that had it.

The list can be narrowed by tags (all of those chosen), file type, who added it, when it last changed, whether it's published and which series it's in, and sorted by title, newest, most recently changed or series period. Once a filter is on, the list looks in every folder below where you are. A set of filters can be saved as a view, which goes in the library's side rail for everyone there; "the past month" stays the past month, not the month it was saved.

## Reader copies

Every version gets a reader copy: the rendition worker turns its file into Markdown with [Docling](https://github.com/docling-project/docling), with the pictures it shows, a thumbnail of a PDF's first page, and its words as plain text for search. The original stays as it was; the reader copy is what Folio shows people to read. Each version says how its copy is coming along (`reader.state`: queued, running, ready or failed). A file Docling can't read fails at once with why; anything else (the bucket down, say) is tried again after a minute, then four, then sixteen, and then fails. Whoever may change the document can ask for a failed copy again.

The worker leases one version at a time from Folio's `renditions` table, so any number can run side by side, and hears of new versions straight away (Postgres `LISTEN`). Under `pnpm dev:app` there's no worker: Markdown and plain text are their own reader copies, and other files say the worker isn't running.

## Reading

Opening a document opens its reader page: the reader copy as a page of text, set in the kit's type and the floor's colours, light or dark. Its headings make the contents down the side, which follow along as you read and take you to a heading in one press. Every heading and paragraph has a stable anchor (`#claims`, `#b12`), so a link can point into a document. The text can be made smaller or larger, and the page wide or narrow; Folio remembers that for you, on that browser. It also remembers where you got to in each version and takes you back there next time. The side panel has the document's versions (an older one says so, with a way to the newest), its tags, and "Download the original" one press away. Until a version's reader copy is ready, the page says it's being made; if it failed, it says why, and whoever may change the document can try again.

## Home and Find

Folio's card on Home (on every kind of floor) says how much has been published to you since you last opened "Published to you", names the newest of it, and opens it in one press; the floor's leads also see how many drafts are waiting to be published in its libraries. The card counts drafts on the floor it's on and not the teams below, as a lead manages only their own floor's libraries.

Find (`search: true`) asks `GET /v1/search?q=` as you type. It answers with up to ten documents you may read, or that have been published to you, that have every word you typed as the start of a word in their title, their tags or their text, best first: a word in the title counts most, then in a tag, then in the text. Its readers search a document's newest version; its audience searches only the version published to them. The text is the version's own (the rendition worker's), up to its first 400,000 characters. A document in a library on another team's floor you're on opens there; anything else opens where you are.

## Other apps

Folio handles the standard intents, so another app can use its documents without knowing about Folio:

- `document.open` opens a document to read, at the version asked for.
- `library.open` opens one of its libraries.
- `document.pick` opens Folio over the asking app as a picker. The person finds a document by what they type (as Find does) or looks through a library on this floor or shared with them, newest first. Only the kinds of file the asking app takes (`accept`) are offered. Folio answers with a `DocumentRef`: the newest version, or for someone who only has a document because it was published to them, the version published to them. Closing the picker cancels the request.
- `folio.open` `{ path }` opens Folio at a place in it, as its address has it. Its card on Home uses it.

## Keeping deleted documents

A deleted document drops out of sight straight away, but its files stay in the bucket for the retention period: 30 days, or what an admin sets as "Keep deleted documents for" in Admin, Apps, Folio (1 to 3650 days). Once a deleted document is older than that, Folio's service removes every file of it (each version's original, reader copy, thumbnail and pictures) and forgets its text, then records `document.purged` in the activity log; its record stays so the log can still name it. It looks once an hour. While the registry can't say what the period is, nothing is removed. Files go first, so a document whose files couldn't all be removed is tried again next time.

## On the record

Folio writes to the platform's audit log (the `audit:write` scope): a library made or archived, a series made or removed, a document uploaded (with its series and issue number when it's an issue), a version added, a document deleted, published or withdrawn, every change to who it's shared with, and every download of an original. A download is given only once it is on the record: while the audit log can't be reached, downloads wait.

## API

All under `/api/folio/v1`, sent with the floor's `X-Workspace-Id` (`ctx.fetch` adds it).

| | |
| --- | --- |
| `GET /levels` | The levels a library is built from (collection › subcollection › series › subseries › file), called what the org calls them, what each may hold, and whether the caller may rename them |
| `PUT /levels/:level` `{name, plural}`, `DELETE /levels/:level` | Rename a level for the whole org, or give it its own name back (the org's leads, on the org's floor) |
| `GET /libraries?archived=` | The floor's libraries (its collections), and whether the caller can make one. With `archived=true`, a lead also gets the archived ones |
| `POST /libraries` `{name, description?}` | A new library (the floor's leads) |
| `GET /libraries/:id` | A library with its folders, tags (the org's and its own), authors, saved views, series, and what the caller may do there |
| `PATCH /libraries/:id` `{name?, description?, freeTags?}` | Rename or describe it, or let anyone add tags (leads) |
| `POST /libraries/:id/archive` | Take it off the floor's list (leads) |
| `PUT /libraries/:id/state` `{state, note?}` | Move it through its lifecycle: open, closed (nothing new goes in) or archived (whoever manages it). An archived one can be opened again |
| `GET /libraries/:id/moves?folder=` | Every lifecycle move of the library, or of one of its folders, newest first |
| `POST /libraries/:id/folders` `{name, parent?, level?, description?}` | A subcollection, series or subseries: at `level`, or the next level down from `parent` (or the top). Refused where that level can't go, and inside anything closed |
| `PATCH /libraries/:id/folders/:folder` `{name?, description?}` | Rename or describe it |
| `PUT /libraries/:id/folders/:folder/state` `{state, note?}` | Open, close or archive it (whoever manages the library) |
| `DELETE /libraries/:id/folders/:folder` | Remove an empty folder |
| `GET /libraries/:id/documents?folder=&below=&tag=&type=&author=&since=&from=&to=&state=&series=&sort=&limit=&offset=` | The documents in a folder (or at the top), or with `below=true` everything inside it, filtered and sorted, with the `total`. `tag`, `type`, `author` and `state` repeat; `type` is pdf, word, html, markdown or text; `since` is week, month, quarter or year; `state` is draft, published or withdrawn; `series` is one series' issues; `lifecycle` (repeats) is the state of the newest version; `sort` is title, newest, updated or period |
| `POST /libraries/:id/documents?filename=&title=&folder=&tag=&series=` | Upload a document: the body is the file, its `Content-Type` its type; `tag` repeats. With `series`, it's that series' next issue: named, numbered, tagged and published to its audience when the uploader may (otherwise a draft, with why in `draft`) |
| `PUT /libraries/:id/documents/:doc/tags` `{tags}` | Give a document exactly these tags |
| `GET /libraries/:id/documents/:doc` | A document with its versions, newest first, its `state` and what's `published`. To its audience alone: only the version that's out, as `only`. An issue has its `issue` (number and period) and `run`: its series, the issues either side the caller may read, and whether they follow it |
| `PATCH /libraries/:id/documents/:doc` `{title?, folder?}` | Retitle it, or move it (`folder: null` is the top) |
| `DELETE /libraries/:id/documents/:doc` | Take it out of the library |
| `POST /libraries/:id/documents/:doc/versions?filename=` | Its next version, sent as above |
| `GET /libraries/:id/documents/:doc/versions/:n/original` | Version n's file as it was uploaded |
| `PUT /libraries/:id/documents/:doc/versions/:n/state` `{state, note?}` | Move version n through its lifecycle: in progress, in review and complete for whoever may change it, issued and retired for whoever manages it. The document's `can.moves` says where its newest version may go |
| `GET /libraries/:id/documents/:doc/moves` | Every lifecycle move of its versions, newest first |
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
| `GET /search?q=` | Find's answer: up to ten documents the caller may read or has had published to them, matching every word by title, tag or text |
| `GET /find?q=` | The same search for the picker, as whole documents with their `libraryName` and `audienceOnly` (only the version published to them is theirs) |
| `GET /home` | Home's card: what's been published to the caller since they last looked (`published.new`, the newest three), and for the floor's leads its `drafts` |
| `PUT /published/looked` | The caller has looked at what's published to them: Home stops counting it as new. The app sends it when "Published to you" opens |
| `GET /documents/:doc` | Where a document is (`{id, library, title}`), for `document.open`, which gives only its id |
| `GET /libraries/:id/series` | The library's series, each with the issue it expects next (`next`, with `dueBy` and `overdue`), whether the caller follows it and what they may do |
| `POST /libraries/:id/series` `{name, cadence, description?, audience?, tags?, parent?, folder?}` | A schedule for a series (whoever manages the library): a new series in `parent` or at the top, or `folder`, a series already there. `cadence` is weekly, monthly, quarterly or adhoc. Issues go in the series |
| `PATCH /libraries/:id/series/:series` `{name?, cadence?, description?, audience?, tags?}`, `DELETE …` | Change a series, or remove one with no issues (whoever manages the library) |
| `GET /series/:series` | A series with its audience named, for its library's readers and its audience |
| `GET /series/:series/issues?limit=&offset=` | The issues the caller may read, newest period first |
| `PUT /series/:series/follow` `{following}` | Be told of each issue published to you, or stop |
| `GET /tags` | The org's tags, and whether the caller keeps them |
| `POST /tags` `{name}`, `PATCH /tags/:tag` `{name}`, `DELETE /tags/:tag` | Keep the org's tags (leads on the org's floor) |
| `POST /libraries/:id/tags` `{name}` | A tag for the library (leads, or anyone when it takes free tags) |
| `PATCH /libraries/:id/tags/:tag` `{name}`, `DELETE /libraries/:id/tags/:tag` | Rename or remove one of its tags (leads) |
| `POST /libraries/:id/views` `{name, query}` | Save a view: `query` is `{folder?, tags?, types?, authors?, since?, sort?, states?, series?}` |
| `PATCH /libraries/:id/views/:view` `{name?, query?}`, `DELETE /libraries/:id/views/:view` | Change or delete a view (whoever saved it, or leads) |
