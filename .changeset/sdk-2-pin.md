---
'@apps/folio-frontend': minor
'@apps/folio': minor
---

Artifacts needs SDK 2.0: its manifest takes `^2.0.0` and it builds against mfe-sdk 2.0.0 and Quill 0.8.0, the kit an SDK 2.0 shell serves. Quill 0.8's `AppError` says a service's refusal in its sentence (`detail`), so Artifacts' own stopgap for that is gone.
