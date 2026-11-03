# Artifacts: notes for coding agents

Artifacts is an AUGUR pillar app: the documents kept for you, your teams and the org. It lives in its own repository and is
built only against AUGUR's published packages (`@augur/*`, aliased from `@harry-burton-dev/augur-*` on
GitHub Packages). AUGUR itself, its ADRs and its guides are in the `im-platform` repository; read its
AGENTS.md and the ADRs there before changing how this app reaches the platform.

## Where to look
- AUGUR's ADRs (`im-platform` docs/decisions), especially 0012 (apps in their own repositories), 0015
  (React, Quill, Tailwind) and 0047 (how this repository releases).
- This app's own decisions: `docs/decisions/` here.
- The task: its Linear issue (team PER, initiative AUGUR).

## Rules
- The same rules as AUGUR: names, limits and URLs come from config or the manifest, never literals from chat;
  unavailable things stay visible and say why; a new dependency needs a record.
- Reach AUGUR only through `@augur/*` packages, the gateway, the manifest and events. Never bundle React or
  the kit: the shell serves them (`isSharedModule` in vite.config.ts).
- Every pull request carries a changeset (`pnpm changeset`). Merging the Version packages pull request
  releases the app as a beta; AUGUR's Promote to stable makes it stable.
- `pnpm install`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Locally you need
  `NODE_AUTH_TOKEN` set to a token that can read GitHub Packages.
- Merge your own pull request once CI is green, after merging fresh `origin/main` into it.
- Nothing in the repository names the tool that wrote it: no assistant trailers on commits or attribution
  in pull requests, and no links to private chats.
