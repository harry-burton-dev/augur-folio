---
'@apps/folio-frontend': minor
---

Artifacts' frontend starts with the app-frontend starter and builds for SDK 2.0: `defineReactApp` mounts the app, its picker (`document.pick`) and its card on Home; its places are on the router (`placeRoutes`), so Back and Forward move inside it without the shell mounting it again; and its calls go through the app client (`createAppClient`), so every failure is an `AppError` in words people can act on. A document another app opens by its id alone now has an address of its own, `/documents/<id>`. Quill 0.7 and Common 0.7.
