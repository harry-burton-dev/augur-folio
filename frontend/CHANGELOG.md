# @apps/folio-frontend

## 0.4.0

### Minor Changes

- bb91780: Who can open something now includes the floors it's published up to. Artifacts' access answers list `placed`: the steps of the thing and of whatever it's inside, each with who that floor lets in, what it shows, and the floors it came up through. Share lists them under **Published up to**, and "Who can open this, explained" sends them to Auspex. Auspex reads an entry's optional `chain` and `shows` and says "Up from Payroll through Finance, showing Complete and Issued".
- 81281ae: Artifacts shares folders: whoever manages a library shares a folder with **Share** inside it, and whoever it's shared with reads everything inside it, while it stays inside. A document's Share says who reaches it through a folder.
- ca1e0f9: Artifacts tags folders: a folder's tags count for everything inside it when you filter by tag, and they're set in the folder's details by whoever may change it. Merging an org tag into a library's takes folders along, and a tag that goes leaves them.
- fa08231: Artifacts has a **Level names** screen in its side rail. Everyone sees what each level of a library is called and what it holds. The org's leads, on the org's floor, can rename a level for the whole org or give it its own name back.
- e0e9c83: Artifacts links records: a library, folder or document can relate to, supersede or respond to another, be about a thing in Data Atlas, or serve an intent in Mandate (`@augur/records`' relations). Links read both ways, a linked record you can't open stays listed and says so, and the reader and a library's or folder's details have a Links section to add, open and remove them.
- bfff2fe: Artifacts moves what was published the old way onto publishing up the floors, by itself: a floor above gets the document published up showing Issued, anyone else it went to keeps it as a share, and the old publication ends on its record. Publishing one version to an audience is now only for a series' issues; any other document is published up the floors, and the reader no longer offers the old Publish for it.
- bef7098: Artifacts' screens take on levels, lifecycles and publishing up: the places inside a library show as cards named by their level, each library or folder has its details and lifecycle, a version moves on from the reader, anything can be published up the floors (with the floors it can't go to saying why), and what was published up to a floor shows under From below. `GET /placements` now says where the caller could publish a record next.
- bb91780: The standard unit intent (SDK 1.8): `UnitRef` and `isUnitRef`, `UNIT_OPEN` and `openUnit`, and `UNIT_LEVELS`. A unit is one place in a floor's library at any level (collection, subcollection, series, subseries or file). Artifacts handles `unit.open`, opening the library, the folder or the file.

### Patch Changes

- b65c6da: The guide (docs/folio.md) describes Artifacts as it is now: one shape for every library, the lifecycle, publishing up the floors, links and level names, with new screenshots. The reader's "where it sits" link above the title is styled as a quiet link, not a bare button.
- Updated dependencies [bb91780]
- Updated dependencies [bef7098]
- Updated dependencies [e0e9c83]
  - @augur/mfe-sdk@1.8.0
  - @augur/ui-kit@1.7.0

## 0.3.3

### Patch Changes

- Updated dependencies [5b2c80c]
  - @augur/mfe-sdk@1.7.0

## 0.3.2

### Patch Changes

- effebfe: App kit, part 2: the frame. New `ui-app-frame` (the slate ground, a rail, the main column and an aside), `ui-page-head` (the trail of what a page is inside, its title, one line of summary, and two actions with the rest in ⋯) and `ui-section` (a labelled part with its count, one action and a why, folding after five). New token `measure-rail` (240px). Type tokens are now emitted in rem, so a person's browser text size scales them. Artifacts, Mandate, Data Atlas and Auspex use the frame and page head instead of their own grids, heads and trails.
- 2c9caf0: App kit, part 1: nothing is obtuse. `ui-button` and `ui-icon-button` take a `reason`: disabled with one, they stay focusable and say why on hover and focus, and it's read aloud. List rows, list actions and menu entries take a `reason` too. The kit warns on localhost about a disabled control without one, and `pnpm check:reasons` fails a platform screen that has one. New parts: `ui-notice` (one sentence that needs attention, with one action), `ui-note` (a quiet line with its `why` one press away) and `ui-can` (what you can do here, and who can do the rest). Every disabled control in Admin, the shell, Artifacts, Mandate and Data Atlas now says why, and ones that were only waiting for a request show as busy instead.
- 2487ae0: App kit, part 5: the writing kit. New `ui-date` (a day said and typed in words, with quick choices and the calendar one press away), `ui-people-picker` (people and teams by name; ones that can't be added stay and say why), `ui-editor` (Markdown without a toolbar at rest: a bar on a selection, Ctrl B and Ctrl I, `@` and `#` mentions saved as references, and a soft length guide) and `ui-prose` (shows what the editor writes, safely). Data Atlas's seven date fields and Mandate's "Done by" use `ui-date`, and Mandate says its dates in words. Artifacts' share dialog finds people with `ui-people-picker`. Mandate's statement, back-brief and concern are written in `ui-editor` and shown with `ui-prose`. Timeline days with a year no longer carry a stray comma.
- Updated dependencies [effebfe]
- Updated dependencies [84fab17]
- Updated dependencies [2c9caf0]
- Updated dependencies [b716037]
- Updated dependencies [2487ae0]
  - @augur/ui-kit@1.6.0

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
