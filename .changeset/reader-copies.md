---
'@apps/folio': minor
---

Artifacts makes a copy of each version to read in the app again, without ML models. A new worker part takes each version from a queue in the app's own schema, three tries each, and makes Markdown for the kit's reader with the pictures it names, a picture of a PDF's first page, and the text Find searches. PDFs are read with Poppler (a scan shows as pictures of its pages), Word documents with Mammoth, Markdown as written, web pages and plain text as text; any other file says why it has none and offers the original. The image now carries Poppler, and a deleted document's copies are cleared with its files.
