# @apps/folio

## 0.9.0

### Minor Changes

- 070903a: The manifest says what kind of app this is (ADR 0032): a pillar app: part of the foundation of what AUGUR produces. Needs SDK 1.11 or later, the first that knows the kind, so an older AUGUR refuses it with a reason instead of failing to register it.
- 745f0f7: Artifacts starts with the service kit's app-service starter: errors are problem details, the floor check and the audit, notification and people adapters come from the kit, named from the manifest. Its late-issue reminders, publication moves and clear-out of deleted documents run as scheduled jobs (once per tick across instances, recorded in the audit log), and renditions are handed to the worker as jobs on DBOS.
- 62ed262: Artifacts starts again as an app on the app contract (contract 3), as the accepted rebuild spec sets out. Its manifest is manifest 3: the rail's places (Home, Library, Shared with you, and From below on team and org floors), its commands and radial actions on documents, folders and collections, five About sections, the retention setting, review in the Inbox, its notification kinds, Find and a Home card. It asks for `inbox:write` as well as before; the knowledge graph scopes come with publishing, once AUGUR releases them. Its parts run from Score files (`web`, `migrate`) on service kit 0.18, and its screen runs in the shell's sandbox on SDK 3, drawing Home with Quill's remote elements. The old frontend, the SDK 2 service and the Python rendition worker are gone; contract 3 dropped the old app and its data. The store, reader copies without ML models and the rest of the screens follow.
- da96381: Artifacts keeps documents again. Each floor has one library, whose top is its collections, with subcollections, series and subseries below and the org's own names for them. A document is uploaded as it is (up to the manifest's limit) into the app's bucket, and each version moves through its own lifecycle: In progress, In review, Complete, Issued, Retired, every move kept. A version sent for review puts an item in the floor's leads' Inbox, closed once it moves on. Tags (the floor's and the org's, a folder's counting for all inside it), grants to people and teams on the library, a folder or a document, Shared with you, the people picker's search, Find and Home are served too. A deleted document's files are cleared once the retention setting's days pass. The part now asks for its bucket and signs in through the gateway for the Inbox, people and the audit log.
- 43b8068: Documents link to each other again, and series can be followed:

  - **Links.** A document links to another on its floor: relates to, supersedes or responds to. About shows its links both ways ("Supersedes", read back as "Superseded by"). A linked document the person can't open stays listed and says so. Whoever can change the document links and unlinks it, from its actions, its radial menu or About. "About" and "Serves" stay listed, unavailable, each saying why.
  - **Follow.** Anyone who can read a series can follow it from the pane. Followers are told each time one of its documents is Issued (the spec's D6, in place of sending issues to an audience).

  A migration adds the links and follows tables.

- 9bfa2e1: A feature preview, `lit-path` (PER-283): with it on, the path in the side rail draws itself down to the library or folder you open. Off until someone turns it on in Previews. Artifacts now builds on Quill 0.9 and Common 0.8.
- bbaedae: Artifacts' front page takes PDR-010's amendments: a plain heading instead of the big centred title, ambient cards dimmed but never blurred, and Actions showing everything that needs you at once (New still pulls its cards in behind the light). Each of Harry's first choices is one change away in `quill/front.ts`.
- e980d93: Artifacts publishes up the floors again:

  - **Publish up.** A document or a folder (its radial menu, or the document's actions) opens a dialog that lists every floor above, with why for any it can't reach, and the states that floor sees: Complete and Issued at first. Publishing to the org needs the publisher role. A floor that received something can publish it on up, never showing more. The floor it goes to is told.
  - **From below.** What arrived waits there until the floor's leads give it a place in their library, and Home tells them. A folder published up opens there at the states it shows.
  - **One place.** Off its own floor, someone reads only the newest version their floors are shown. Each person sees a thing in one place, the highest floor that shows it to them; the floor below shows a signpost to it, and still keeps and changes it.
  - **Up the floors** in About shows its chain, the owner marked. Whoever published it, or the leads of the floor it's on, can take it back, and every step that went on up from it goes too.

  A migration adds the placements table.

- d3b3ca2: The reader's side panel is About only. How the text is read (smaller, larger, wide page) is in a reading bar over it, and what can be done to the document (download, share, publish, publish up, follow its series, change it) is in its actions: right-click or long-press its title, or press Actions beside it. Each action it can't do stays, dimmed, saying why. Shared libraries now name whose floor each thing comes from (`floorKind`, `floorName`, `within` on `GET /v1/shared`), from identity's directory; when it can't be asked, the page says so.
- 7459bad: Artifacts makes a copy of each version to read in the app again, without ML models. A new worker part takes each version from a queue in the app's own schema, three tries each, and makes Markdown for the kit's reader with the pictures it names, a picture of a PDF's first page, and the text Find searches. PDFs are read with Poppler (a scan shows as pictures of its pages), Word documents with Mammoth, Markdown as written, web pages and plain text as text; any other file says why it has none and offers the original. The image now carries Poppler, and a deleted document's copies are cleared with its files.
- cf47d6a: The reader's actions gain Move to…, which lists every state with why the unavailable ones can't be picked and asks before issuing or retiring. Selected words get a small bar beside them with Add to Data Atlas and Copy a link (the link opens the document at that paragraph). About shows the lifecycle without buttons.
- 745f0f7: The rendition worker runs each reader copy as a durable DBOS workflow, taken from the `folio.renditions` queue the service puts it on, instead of leasing rows of the `renditions` table itself. The table stays the record of how each copy is coming along. The worker keeps its jobs in the `folio_jobs` schema and no longer reads `POLL_SECONDS`. DBOS's Python SDK (`dbos` 3.4.0) is pinned in `worker/requirements.lock` with the worker's other packages. Rows the old worker was still holding go back on the queue the first time the new worker starts.
- b3d8533: Artifacts has its screens again, drawn by the shell from Quill's remote elements:

  - **Library and folders.** The library shows its collections as tiles, with the collections also listed under Library in the rail. A folder shows its path, the folders in it as tiles and its documents as rows, with a filter bar by lifecycle and order.
  - **Document.** Opening a document reads its copy in the reader, with its versions under it. When there is no copy to read, the screen says why and offers the original.
  - **About.** It shows the version's lifecycle and moves, where the document is, who can open it, and its floor.
  - **Shared with you and From below.** Shared with you lists what other floors let you open. From below says plainly that nothing has been published up yet.
  - **Dialogs** make a folder, add documents (from a file button or by dropping files), move a version to a new state, and share a document with people or teams found by name.
  - **Commands** in the pane and the radial menu act on the thing they were opened on. Publish up and Say what it's about say they come in the next version.

  The document's answer now also says which floor the document is kept on.

- 569ec08: Artifacts needs SDK 2.0: its manifest takes `^2.0.0` and it builds against mfe-sdk 2.0.0 and Quill 0.8.0, the kit an SDK 2.0 shell serves. Quill 0.8's `AppError` says a service's refusal in its sentence (`detail`), so Artifacts' own stopgap for that is gone.

### Patch Changes

- c424536: Only whoever published something, or the leads of the floor it went to, can see what would go with it if it were taken back. An upload's limit is the manifest's `maxUpload`, the one the gateway holds Artifacts to. The one-off move onto publishing up stops looking once nothing is left to move.
- 817a938: Artifacts keeps its own entry in the Backstage catalog, `catalog-info.yaml`, written by `augur-app catalog` from the manifest and the package.json files. CI checks it is current, and Version packages rewrites it.
- 4714cc2: Artifacts' manifest says it binds records to entities (`links.entities`, `bindings: ["record"]`, SDK 2.1), so Data Atlas finds its binding events through the registry rather than a list in its own code. It needs AUGUR 0.22.0 or later, whose registry reads these fields.
- 604343a: Find and the picker now find what was published up to a floor, for the people on that floor, searching only the newest version that passes what was published up.
- 88dc7b7: Folio keeps its libraries only in Postgres: its in-memory store is gone, and its tests run on real Postgres. Under `pnpm dev:app` it needs `DATABASE_URL` (the dev stack's Postgres); without a bucket, a stand-in still makes reader copies of Markdown and text.
- edd0c7c: Artifacts' run scenarios follow the rebuilt app. RUN-15 publishes a document up from its author's own floor and checks it waits under From below on their team, opens there at the one version it shows, and stays closed to anyone else. New: RUN-27 finds and reads the organisation's guide by its title, RUN-28 sends a document for review through the lead's Inbox and Issues it, RUN-29 shares a document with one person to read and takes it back, and RUN-30 checks version 2 in progress leaves Issued version 1 as it was.
- bd1bc12: The rendition worker stops reading a Word, HTML or Markdown file that runs past its timeout, as Docling already did for PDFs. Its image has a healthcheck, and it sends OpenTelemetry once a collector is named (decision 0002).
