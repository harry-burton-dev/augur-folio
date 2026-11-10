# @apps/folio-frontend

## 0.9.0

### Minor Changes

- 62ed262: Artifacts starts again as an app on the app contract (contract 3), as the accepted rebuild spec sets out. Its manifest is manifest 3: the rail's places (Home, Library, Shared with you, and From below on team and org floors), its commands and radial actions on documents, folders and collections, five About sections, the retention setting, review in the Inbox, its notification kinds, Find and a Home card. It asks for `inbox:write` as well as before; the knowledge graph scopes come with publishing, once AUGUR releases them. Its parts run from Score files (`web`, `migrate`) on service kit 0.18, and its screen runs in the shell's sandbox on SDK 3, drawing Home with Quill's remote elements. The old frontend, the SDK 2 service and the Python rendition worker are gone; contract 3 dropped the old app and its data. The store, reader copies without ML models and the rest of the screens follow.
- 30ad1c5: Artifacts' frontend starts with the app-frontend starter and builds for SDK 2.0: `defineReactApp` mounts the app, its picker (`document.pick`) and its card on Home; its places are on the router (`placeRoutes`), so Back and Forward move inside it without the shell mounting it again; and its calls go through the app client (`createAppClient`), so every failure is an `AppError` in words people can act on. A document another app opens by its id alone now has an address of its own, `/documents/<id>`. Quill 0.7 and Common 0.7.
- 569ec08: Artifacts needs SDK 2.0: its manifest takes `^2.0.0` and it builds against mfe-sdk 2.0.0 and Quill 0.8.0, the kit an SDK 2.0 shell serves. Quill 0.8's `AppError` says a service's refusal in its sentence (`detail`), so Artifacts' own stopgap for that is gone.
