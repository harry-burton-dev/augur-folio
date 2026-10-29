# @apps/folio-frontend

## 0.3.1

### Patch Changes

- Updated dependencies [d68128b]
- Updated dependencies [7ee3531]
- Updated dependencies [d52bfce]
- Updated dependencies [a9cfcf7]
  - @augur/ui-kit@1.5.0
  - @augur/mfe-sdk@1.6.0

## 0.3.0

### Minor Changes

- 3b11978: Who can open this, explained: Auspex handles `access.explain` over the app that asks, counting only people the person may know about and naming everyone left out, and Artifacts raises it from Who can see it.
- 513e2e9: Artifacts reader: mark the words that name a ship, port, person or organisation and choose Add to Data Atlas to send them to the floor's Triage. The button stays in sight and says what it waits for.

### Patch Changes

- 1580b6b: Artifacts' Libraries group and its All libraries page no longer repeat the app's own icon.
- Updated dependencies [1580b6b]
- Updated dependencies [d324552]
- Updated dependencies [18bf27c]
- Updated dependencies [f01fcea]
- Updated dependencies [8f69cb5]
- Updated dependencies [b556614]
- Updated dependencies [513e2e9]
- Updated dependencies [feeffdd]
- Updated dependencies [ae92eed]
- Updated dependencies [778b6f9]
- Updated dependencies [513e2e9]
- Updated dependencies [28d8775]
  - @augur/mfe-sdk@1.5.0
  - @augur/ui-kit@1.4.0

## 0.2.0

### Minor Changes

- 70df61e: Folio is called Artifacts wherever people see it: its name in the manifest and every message it shows. It opens straight into its own side menu (`"orbit": false`) rather than the shell's Orbit. Its id, route, schema, bucket, containers and `FOLIO_*` settings are unchanged.

### Patch Changes

- Updated dependencies [70df61e]
- Updated dependencies [aa0f0f4]
  - @augur/mfe-sdk@1.4.0
  - @augur/ui-kit@1.3.0

## 0.1.0

### Minor Changes

- c95e799: Folio takes documents: drop PDF, Word, HTML, Markdown or text files (up to 200 MB) into a library or folder, and each is kept exactly as uploaded, as numbered versions with their size and SHA-256, in Folio's own bucket. A document opens to its versions, each one downloadable; whoever added it, or a lead, adds the next version, retitles or moves it, or deletes it. Uploads, versions, deletions and every download of an original go in the platform's audit log, and a download waits while the log can't be reached.
- a3da8c7: Folio in the shell: a card on Home with what's been published to you since you last looked (and, for leads, the floor's drafts waiting to publish), and Find over the documents you may read, by title, tags and text. A `folio.open` intent opens Folio at a place in it.
- 043d5d3: Folio handles `document.pick` with a picker (find by what's typed, or look through a library, in the kinds of file asked for) and `library.open`, beside `document.open`.
- 936bb00: Folio publishes documents. Whoever manages a document puts one version out to a team, a team and the teams below it, or the whole org; everyone it goes to can read that version (and only that one) from their own floor, finds it under "Published to you", and is told, with a Read button that opens it. Publishing again replaces what was out, and withdrawing takes it back, with a reason. Team leads publish to their team and below; the org, other teams and your own floor need the publisher role. Lists show and filter by draft, published and withdrawn. Folio now tells other apps what happened (`folio.document.*` events, from an outbox), and handles `document.open`.
- f1b5773: Folio's reader page: a document opens as its reader copy, with contents from its headings, text size and width controls, its versions and tags, and Download the original one press away. Folio remembers your text settings and where you got to in each version. The page has its own address, so a reader link can be shared.
- 88deb8b: Folio makes a reader copy of every version: a new rendition worker (Python, with Docling) turns PDF, Word, HTML, Markdown and plain text into Markdown, with its pictures, a thumbnail of a PDF's first page, and the text for search. Versions say how their reader copy is coming along, the document dialog shows it, and a failed one can be asked for again. The service serves the reader copy, its pictures, the thumbnail and the text.
- d5d54cc: Series: a named run of documents in a library on a cadence (weekly, monthly, quarterly or now and then), with the tags and audience each issue starts with. The next issue is added from one file, numbered, named for its period and published; people follow a series to be told of each issue, its owner is reminded when one is late, and the reader moves between issues.
- 342f117: Folio shares libraries and documents. A library lets in everyone who can stand on its floor, from wherever they are, and whoever manages it can let in a person, a team, a team and the teams below it, or the whole org, to read, edit or manage it, or just one document of it. Folio asks identity who each person stands for (the new `people:read` scope) and writes down each document's readers, so every list keeps to what the person may see. The Share dialog finds people and teams by name, and what's shared from other floors is under "Shared with you". Every change to who can see something is on the record.
- 22be7f4: Folio finds documents by tags, filters and saved views. Each library has its own tags and shares the org's (kept by the leads on the org's floor); leads can let anyone add tags. Documents are tagged as they're uploaded or afterwards. The list filters by tags, file type, who added it and when it changed, looking in every folder below, and sorts by title, newest or recently changed, a page at a time. A filter set can be saved as a view in the library's side rail for everyone there.
- a25ab8a: Folio, the document libraries app, replaces the Library stub. Each floor keeps its own libraries, with folders up to six deep: anyone on the floor can see them and make folders, and the floor's leads make, rename and archive libraries. Folio has its own layout below the shell's top bar: a side rail with the floor's libraries and the open library's folders, and a list of what's inside.

### Patch Changes

- Updated dependencies [043d5d3]
- Updated dependencies [c95e799]
- Updated dependencies [936bb00]
- Updated dependencies [f1b5773]
- Updated dependencies [d5d54cc]
- Updated dependencies [22be7f4]
- Updated dependencies [a25ab8a]
  - @augur/mfe-sdk@1.3.0
  - @augur/ui-kit@1.2.0
