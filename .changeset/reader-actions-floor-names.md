---
'@apps/folio': minor
---

The reader's side panel is About only. How the text is read (smaller, larger, wide page) is in a reading bar over it, and what can be done to the document (download, share, publish, publish up, follow its series, change it) is in its actions: right-click or long-press its title, or press the mark beside it. Each action it can't do stays, dimmed, saying why. Shared libraries now name whose floor each thing comes from (`floorKind`, `floorName`, `within` on `GET /v1/shared`), from identity's directory; when it can't be asked, the page says so.
