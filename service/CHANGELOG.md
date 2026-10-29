# @apps/folio

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
