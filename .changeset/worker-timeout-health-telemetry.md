---
'@apps/folio': patch
---

The rendition worker stops reading a Word, HTML or Markdown file that runs past its timeout, as Docling already did for PDFs. Its image has a healthcheck, and it sends OpenTelemetry once a collector is named (decision 0002).
