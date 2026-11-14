# Reviewing a change to Artifacts

Read this before reviewing, and before opening a pull request. AGENTS.md has the rules for writing code; this
file has what a review looks for and what each pull request needs before it merges. The Review check (AUGUR's
reusable Review workflow) checks the parts a machine can.

## Tiers

The paths a pull request changes set its tier (`.github/review-tiers.json`). Its tier is its highest path.

- **Low**: docs, tests, stories, changesets only. Merges on green CI.
- **Medium**: everything else. Needs the description's sections and a pre-merge review.
- **High**: the paths listed as `high`. Needs what Medium needs, under 400 changed lines (or a reason), and, on
  Harry's paths (workflows, the manifest (what the app may do) and these rules), **Harry's ok**: he answers the three questions below; only then add the `harry-ok`
  label. Never add it on your own. A push that changes the pull request's own diff takes it off.

A bot's pull request (Renovate) has no description to check: CI and Harry's ok on his paths are its gates.

## Before you open the pull request

1. Run the checks AGENTS.md lists, and paste their result lines into Testing.
2. Medium and High: run `/code-review high` in a fresh context against the pull request's diff. Fix or answer
   findings ranked 1 to 6. Say what you did in the Review section.
3. At most two review rounds; the second reviews only what changed. If it still finds an Important problem,
   stop and rethink the approach, and say so.
4. One concern per pull request. A High one over 400 lines says in Risk: "Over 400 lines because …".

Don't run `/security-review` as a gate: its filter drops findings that matter here.

## The description

`## Testing` (commands and results), `## Not run` (and why), `## Risk` (tier, why, which release path),
`## How to undo`, `## Review` (the `/code-review` run: effort, findings, what was fixed or answered).
Harry's three questions read straight off them: what isn't tested, how to undo it, and which release path.

## What failure looks like here

- **It breaks an install or an upgrade.** A migration the release before can't live with, a Score file or
  manifest change the app runner refuses, a part that starts before what it needs.
- **It reaches round.** Anything past `@augur/*`, the gateway, the manifest and events; React or the kit bundled
  (`isSharedModule` in vite.config.ts).
- **It asks for too much.** A manifest scope or permission the change doesn't need, or data shown to someone
  who may not see it.
- **It hides or hard-codes.** Something unavailable disappears instead of saying why; a name, URL or limit that
  should come from config or the manifest.
- **It loses data or order.** A pg Pool not wrapped in `steadyPool`, an event handled twice, a job that can't be retried.

### The security angle

Admins are not trusted with the server. Fail open is a bug. Defence in depth counts. A bypass that needs an
operational fault (a stale cache, a restart) is still a hole.

## How to report

Open with the count, or say plainly "Nothing needs fixing". Each finding names the file and line, what goes
wrong and when. At most three nits; style is for lint.

## When something is found after the merge

The fix names the pull request that introduced the defect (git blame) and adds the check that would have caught
it: a test, a lint rule, or a line here or in AGENTS.md.
