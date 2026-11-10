# Artifacts

Part of AUGUR, which is proprietary; see `LICENSE`.

Documents kept for you, your teams and the org: a library on every floor, each version moving through a lifecycle, published up the floors to become the floor's trusted record. Folio stays its code name, id, route and schema; people only ever see **Artifacts**.

It is being rebuilt as an app on the app contract (contract 3): its screen runs in the shell's sandbox and the shell draws it with the kit. The rebuild follows the accepted spec, "Artifacts on contract 3 and Endstate" (in the AUGUR handbook), and its records: Artifacts ADR 0003 and PDR-001, and AUGUR's ADR 0092. This version uses no AI.

| Path | What it is |
| --- | --- |
| `manifest.json` | What the shell draws for the app (places, commands, About sections), its settings, the scopes it asks for and the floors it works on (manifest 3). `$schema` points at the schema in `@augur/app-tools`, so your editor checks it; `pnpm check:app` checks it as the registry will |
| `score/` | One Score file per part: `web` (the inbound service, with its database, bucket, sign-in through the gateway, setting and scratch folder) `worker` (makes each version's copy to read in the background, from a queue in the app's schema, with only the database, the bucket and a scratch folder) and `migrate` (a job that runs the migrations before each install switches over). Each says what the part asks for and its limits; `image: .` is pinned by digest in the release |
| `catalog-info.yaml` | The app's entry in Backstage's catalog, written from the manifest and the package.json files by `augur-app catalog`. Don't edit it: CI checks it's current (`pnpm check:catalog`) and Version packages rewrites it |
| `service/` | The image every part runs (`@apps/folio`), with Poppler in it: `src/app.ts` builds it and serves `/healthz`, `src/library.ts` the library's routes, `src/placements.ts` publishing up the floors, From below and one place, `src/links.ts` links between documents and following a series, `src/renditions.ts` and `src/render.ts` the worker's queue and its converters (Poppler for PDFs, Mammoth for Word, Markdown, web pages and text carried over; no ML models), `src/access.ts` who may do what, `src/store.ts` and `src/migrations.ts` the store and its schema, `src/objects.ts` the bucket, `src/platform.ts` the Inbox and the gateway, `src/events.ts` the events pushed to it, `src/index.ts`, `src/worker.ts` and `src/migrate.ts` what each part starts, each reaching the app's database with the service kit's `appDatabaseFromEnv` (none under `pnpm dev:app`) |
| `service/src/api-types.ts` | The wire types, written once: the service answers with them, its OpenAPI document describes them and the frontend reads them |
| `frontend/` | What the shell runs in the app's worker (`@apps/folio-frontend`), drawing Quill's remote elements by name: `src/entry.ts` its `start(ctx)` (routes, commands, drops), `src/routes.ts` where each path leads, `src/screen.ts` Home and its card, `src/library.ts` the library, folders, Shared with you and From below, `src/document.ts` the reader and its About sections, `src/dialogs.ts` new folder, add, move, share, publish up, give it a place and link, `src/api.ts` its calls through the gateway |
| `run/index.ts` | Its scenarios for AUGUR's run suite (augur-run): give each a RUN id there when the app joins the proving run |

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm check:app` run everything; set
`NODE_AUTH_TOKEN` first, and for `check:app` also `GITHUB_REPOSITORY` (`owner/repo`, which names the image; CI sets it).
The store's tests run on Postgres: set `DATABASE_URL` to a database of your own (each test file makes and drops a
schema of its own in it); without it they are skipped. CI gives them one.

## Releases

| Workflow | When | What |
| --- | --- | --- |
| CI | Every pull request | Lint, typecheck, test and build, and the manifest, the Score files and the release file they make checked against contract 3 |
| App previews | A pull request that changes the app | A signed preview its developers can run beside the app |
| App dev builds | Every merge into main | A signed dev build for preview servers |
| Release | Merging Version packages | The beta release `app/folio@<version>`, then AUGUR's feed lists it |

Every pull request carries a changeset (`pnpm changeset`). An empty changeset (`pnpm changeset --empty`) never holds back a release.
