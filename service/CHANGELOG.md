# @apps/folio

## 0.9.0

### Minor Changes

- 070903a: The manifest says what kind of app this is (ADR 0032): a pillar app: part of the foundation of what AUGUR produces. Needs SDK 1.11 or later, the first that knows the kind, so an older AUGUR refuses it with a reason instead of failing to register it.
- 745f0f7: Artifacts starts with the service kit's app-service starter: errors are problem details, the floor check and the audit, notification and people adapters come from the kit, named from the manifest. Its late-issue reminders, publication moves and clear-out of deleted documents run as scheduled jobs (once per tick across instances, recorded in the audit log), and renditions are handed to the worker as jobs on DBOS.
- 9bfa2e1: A feature preview, `lit-path` (PER-283): with it on, the path in the side rail draws itself down to the library or folder you open. Off until someone turns it on in Previews. Artifacts now builds on Quill 0.9 and Common 0.8.
- bbaedae: Artifacts' front page takes PDR-010's amendments: a plain heading instead of the big centred title, ambient cards dimmed but never blurred, and Actions showing everything that needs you at once (New still pulls its cards in behind the light). Each of Harry's first choices is one change away in `quill/front.ts`.
- d3b3ca2: The reader's side panel is About only. How the text is read (smaller, larger, wide page) is in a reading bar over it, and what can be done to the document (download, share, publish, publish up, follow its series, change it) is in its actions: right-click or long-press its title, or press Actions beside it. Each action it can't do stays, dimmed, saying why. Shared libraries now name whose floor each thing comes from (`floorKind`, `floorName`, `within` on `GET /v1/shared`), from identity's directory; when it can't be asked, the page says so.
- cf47d6a: The reader's actions gain Move to…, which lists every state with why the unavailable ones can't be picked and asks before issuing or retiring. Selected words get a small bar beside them with Add to Data Atlas and Copy a link (the link opens the document at that paragraph). About shows the lifecycle without buttons.
- 745f0f7: The rendition worker runs each reader copy as a durable DBOS workflow, taken from the `folio.renditions` queue the service puts it on, instead of leasing rows of the `renditions` table itself. The table stays the record of how each copy is coming along. The worker keeps its jobs in the `folio_jobs` schema and no longer reads `POLL_SECONDS`. DBOS's Python SDK (`dbos` 3.4.0) is pinned in `worker/requirements.lock` with the worker's other packages. Rows the old worker was still holding go back on the queue the first time the new worker starts.
- 569ec08: Artifacts needs SDK 2.0: its manifest takes `^2.0.0` and it builds against mfe-sdk 2.0.0 and Quill 0.8.0, the kit an SDK 2.0 shell serves. Quill 0.8's `AppError` says a service's refusal in its sentence (`detail`), so Artifacts' own stopgap for that is gone.

### Patch Changes

- c424536: Only whoever published something, or the leads of the floor it went to, can see what would go with it if it were taken back. An upload's limit is the manifest's `maxUpload`, the one the gateway holds Artifacts to. The one-off move onto publishing up stops looking once nothing is left to move.
- 817a938: Artifacts keeps its own entry in the Backstage catalog, `catalog-info.yaml`, written by `augur-app catalog` from the manifest and the package.json files. CI checks it is current, and Version packages rewrites it.
- 4714cc2: Artifacts' manifest says it binds records to entities (`links.entities`, `bindings: ["record"]`, SDK 2.1), so Data Atlas finds its binding events through the registry rather than a list in its own code. It needs AUGUR 0.22.0 or later, whose registry reads these fields.
- 604343a: Find and the picker now find what was published up to a floor, for the people on that floor, searching only the newest version that passes what was published up.
- 88dc7b7: Folio keeps its libraries only in Postgres: its in-memory store is gone, and its tests run on real Postgres. Under `pnpm dev:app` it needs `DATABASE_URL` (the dev stack's Postgres); without a bucket, a stand-in still makes reader copies of Markdown and text.
- bd1bc12: The rendition worker stops reading a Word, HTML or Markdown file that runs past its timeout, as Docling already did for PDFs. Its image has a healthcheck, and it sends OpenTelemetry once a collector is named (decision 0002).

## 0.8.0

### Minor Changes

- 6322b40: Artifacts tells other apps when a library, folder or document is linked to an entity in Data Atlas, or unlinked from it: `folio.record.entity-bound` and `folio.record.entity-unbound`, from the outbox in the same transaction as the link. Data Atlas uses them for an entity's "Used by".

## 0.7.2

### Patch Changes

- 85d6ad8: The wire types between the frontend and the service are written once, in the service's src/api-types.ts, and both sides use them. Types only: the frontend bundle and the service build don't change.
- 6f990dd: The manifest's SDK range also accepts SDK 2. SDK 2 only stops serving Lit, which this app never used, so the
  app keeps opening when a deployment moves to an AUGUR shell built on SDK 2.
- 26d54cc: The service stays up when Postgres restarts or drops an idle connection: its database pools log the lost connection (the service kit's `steadyPool`) instead of ending the process (PER-207).
- f240173: The rendition worker installs every Python package from `worker/requirements.lock`, at exact versions checked against their hashes, Torch and Transformers included, so each build of a release installs the same code. CI checks the lock holds `pyproject.toml`'s pins and scans it with OSV-Scanner (PER-219, ADR 0001 here).

## 0.7.1

### Patch Changes

- afdca19: Artifacts is built and released from its own repository now, signed by this repository's release workflow. Nothing changes for people using it.

## 0.3.2

### Patch Changes

- Updated dependencies [137791c]
- Updated dependencies [2021f8a]
  - @augur/service-kit@0.11.0

## 0.3.1

### Patch Changes

- Updated dependencies [ea41136]
  - @augur/service-kit@0.10.0

## 0.3.0

### Minor Changes

- bb91780: Who can open something now includes the floors it's published up to. Artifacts' access answers list `placed`: the steps of the thing and of whatever it's inside, each with who that floor lets in, what it shows, and the floors it came up through. Share lists them under **Published up to**, and "Who can open this, explained" sends them to Auspex. Auspex reads an entry's optional `chain` and `shows` and says "Up from Payroll through Finance, showing Complete and Issued".
- 81281ae: Artifacts shares folders: whoever manages a library shares a folder with **Share** inside it, and whoever it's shared with reads everything inside it, while it stays inside. A document's Share says who reaches it through a folder.
- ca1e0f9: Artifacts tags folders: a folder's tags count for everything inside it when you filter by tag, and they're set in the folder's details by whoever may change it. Merging an org tag into a library's takes folders along, and a tag that goes leaves them.
- e0e9c83: Artifacts links records: a library, folder or document can relate to, supersede or respond to another, be about a thing in Data Atlas, or serve an intent in Mandate (`@augur/records`' relations). Links read both ways, a linked record you can't open stays listed and says so, and the reader and a library's or folder's details have a Links section to add, open and remove them.
- bfff2fe: Artifacts moves what was published the old way onto publishing up the floors, by itself: a floor above gets the document published up showing Issued, anyone else it went to keeps it as a share, and the old publication ends on its record. Publishing one version to an audience is now only for a series' issues; any other document is published up the floors, and the reader no longer offers the old Publish for it.
- 6d7a7e2: Artifacts publishes up the floors: put a collection, folder or document on a floor above through a filter of lifecycle states, publish it further up from there, land it where it belongs, and take it back. Each record has one owner, the highest floor it reached, and each person sees it in one place only.
- bef7098: Artifacts' screens take on levels, lifecycles and publishing up: the places inside a library show as cards named by their level, each library or folder has its details and lifecycle, a version moves on from the reader, anything can be published up the floors (with the floors it can't go to saying why), and what was published up to a floor shows under From below. `GET /placements` now says where the caller could publish a record next.
- a27d3ec: Artifacts gets its form (PER-171, S1 and S2). A library is a collection, and its folders are subcollections, series and subseries, which can be skipped but never turned round. Every version of a file has a lifecycle (in progress, in review, complete, issued, retired), and every collection and folder one too (open, closed, archived), with each move on the record. The org's leads can rename the levels. Existing libraries move over by themselves: deeper folders become subcollections named for where they were, each series with a schedule gets its own series, and versions out to an audience are issued. The move is one way: the nightly backup from before the upgrade is the way back.

## 0.2.2

### Patch Changes

- Updated dependencies [f0d02e2]
- Updated dependencies [bbdad18]
  - @augur/service-kit@0.9.0

## 0.2.1

### Patch Changes

- aa1724a: Services check their settings before they start. The service kit's `loadConfig` takes a list of the settings a service reads (`Setting`, plus `commonSettings` for the ones services share). In production, a missing required setting stops the service with one message listing every problem, instead of falling back to a `localhost` address. A secret can be given as a file in `<NAME>_FILE`. `describeConfig` reports each setting and where it came from, never a secret's value, ready for Admin → Deployment.
- Updated dependencies [aa1724a]
  - @augur/service-kit@0.8.0

## 0.2.0

### Minor Changes

- 70df61e: Folio is called Artifacts wherever people see it: its name in the manifest and every message it shows. It opens straight into its own side menu (`"orbit": false`) rather than the shell's Orbit. Its id, route, schema, bucket, containers and `FOLIO_*` settings are unchanged.

### Patch Changes

- ef587a4: Apps' frontends are kept by version. An app's service gives the registry each version's built frontend before registering it (`publishFrontend` in the service kit, `PUT /v1/apps/{id}/versions/{version}/frontend`), the registry writes it to the new `augur-frontends` bucket that the storage container makes, and the front door serves it from Garage at `/apps/<id>/<version>/`. The manifest the shell is given then points at that version's own copy, so holding an app at an older version in Admin, Apps holds its code too. A version's frontend never changes once given. Folio gives its own on every start. Needs `FRONTENDS_BUCKET_SECRET` in `.env` (docs/upgrade.md); without it apps are served from their manifests' entry as before.
- Updated dependencies [57d3760]
- Updated dependencies [476907a]
- Updated dependencies [ef587a4]
- Updated dependencies [a6b6bca]
- Updated dependencies [948526d]
  - @augur/service-kit@0.7.0

## 0.1.0

### Minor Changes

- f7fc3e6: Apps can offer admins settings: a manifest's `settings` (whole numbers with a label, unit, range and default), set in Admin, Apps and audited as app.setting-changed, kept across versions. The registry serves them at `GET /v1/apps/{id}/settings` to admins and the app itself, and the service kit's `appSettings` reads them. Folio offers "Keep deleted documents for" (30 days by default): past it, a deleted document's files are removed from its bucket and its text forgotten, recorded as document.purged.
- c95e799: Folio takes documents: drop PDF, Word, HTML, Markdown or text files (up to 200 MB) into a library or folder, and each is kept exactly as uploaded, as numbered versions with their size and SHA-256, in Folio's own bucket. A document opens to its versions, each one downloadable; whoever added it, or a lead, adds the next version, retitles or moves it, or deletes it. Uploads, versions, deletions and every download of an original go in the platform's audit log, and a download waits while the log can't be reached.
- a3da8c7: Folio in the shell: a card on Home with what's been published to you since you last looked (and, for leads, the floor's drafts waiting to publish), and Find over the documents you may read, by title, tags and text. A `folio.open` intent opens Folio at a place in it.
- 043d5d3: Folio handles `document.pick` with a picker (find by what's typed, or look through a library, in the kinds of file asked for) and `library.open`, beside `document.open`.
- 936bb00: Folio publishes documents. Whoever manages a document puts one version out to a team, a team and the teams below it, or the whole org; everyone it goes to can read that version (and only that one) from their own floor, finds it under "Published to you", and is told, with a Read button that opens it. Publishing again replaces what was out, and withdrawing takes it back, with a reason. Team leads publish to their team and below; the org, other teams and your own floor need the publisher role. Lists show and filter by draft, published and withdrawn. Folio now tells other apps what happened (`folio.document.*` events, from an outbox), and handles `document.open`.
- 88deb8b: Folio makes a reader copy of every version: a new rendition worker (Python, with Docling) turns PDF, Word, HTML, Markdown and plain text into Markdown, with its pictures, a thumbnail of a PDF's first page, and the text for search. Versions say how their reader copy is coming along, the document dialog shows it, and a failed one can be asked for again. The service serves the reader copy, its pictures, the thumbnail and the text.
- d5d54cc: Series: a named run of documents in a library on a cadence (weekly, monthly, quarterly or now and then), with the tags and audience each issue starts with. The next issue is added from one file, numbered, named for its period and published; people follow a series to be told of each issue, its owner is reminded when one is late, and the reader moves between issues.
- 342f117: Folio shares libraries and documents. A library lets in everyone who can stand on its floor, from wherever they are, and whoever manages it can let in a person, a team, a team and the teams below it, or the whole org, to read, edit or manage it, or just one document of it. Folio asks identity who each person stands for (the new `people:read` scope) and writes down each document's readers, so every list keeps to what the person may see. The Share dialog finds people and teams by name, and what's shared from other floors is under "Shared with you". Every change to who can see something is on the record.
- 22be7f4: Folio finds documents by tags, filters and saved views. Each library has its own tags and shares the org's (kept by the leads on the org's floor); leads can let anyone add tags. Documents are tagged as they're uploaded or afterwards. The list filters by tags, file type, who added it and when it changed, looking in every folder below, and sorts by title, newest or recently changed, a page at a time. A filter set can be saved as a view in the library's side rail for everyone there.
- a25ab8a: Folio, the document libraries app, replaces the Library stub. Each floor keeps its own libraries, with folders up to six deep: anyone on the floor can see them and make folders, and the floor's leads make, rename and archive libraries. Folio has its own layout below the shell's top bar: a side rail with the floor's libraries and the open library's folders, and a list of what's inside.

### Patch Changes

- e2f723e: A guide to Folio for the people who use it and the admins who run it, with screenshots: `docs/folio.md`.
- 94d0c0c: Folio ships with AUGUR. The release builds its images and pins its version, the deploy stack runs it (`folio`, `folio-worker`, its frontend in `web`) and it registers itself on first start with no admin step. The registry's `PILLAR_APPS` are given the scopes their release asks for, can't be pinned to a version, and can be turned off but not removed (409); Admin shows them as shipping with AUGUR, without versions to go back to or a sign-in to issue. The updater restarts Folio and its worker in an upgrade. The service kit works out a bucket key's id from its secret (`bucketKeyIdFor`), so apps need only `S3_SECRET_ACCESS_KEY`. The shell's dev-app mode takes other apps beside the one being developed (`DEV_ALSO`), and the contract tests run with Folio on and off.
- Updated dependencies [f7fc3e6]
- Updated dependencies [94d0c0c]
- Updated dependencies [4608af1]
- Updated dependencies [936bb00]
  - @augur/service-kit@0.6.0
