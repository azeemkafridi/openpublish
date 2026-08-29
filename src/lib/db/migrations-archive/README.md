# Archived migrations (pre-2026-07-27 squash)

These are the 38 journalled migrations (plus 3 orphans) that existed before the schema
history was squashed into a single `0000_baseline`. **Nothing reads this directory.**
It is kept for archaeology only — `git log` on the files is still the best record of why
each change was made.

## Why they were retired

Production never ran them. For its entire history prod deployed schema with
`drizzle-kit push`, which diffs `schema.ts` straight against the live database and keeps
no ledger. The migration files were therefore only ever exercised by local dev, and they
quietly rotted:

- **Two objects existed in `schema.ts` with no migration that creates them** —
  the whole `api_usage_daily` table (plus its PK, FK and two indexes) and
  `posts.post_format`. A database built from these files alone was missing both.
- **Snapshots were missing for journal entries 6, 28 and 37.** Because `drizzle-kit
  generate` diffs against the *newest* snapshot it can find (0036), the next generated
  migration would have re-emitted `ALTER TYPE "platform_name" ADD VALUE 'tumblr'` —
  which fails on replay, since 0037 already added it.
- **Three `.sql` files were never in the journal at all** (`0007_add-platform-content`,
  `0008_add-platform-thread-parts`, `0009_add-performance-indexes`), so `migrate` never
  ran them. Their effects survived only because later migrations happened to re-add them.

Repairing that in place would have meant hand-authoring three large snapshot documents,
where a subtle mistake fails silently at the *next* `generate`. Squashing was verified
instead: a database built from `0000_baseline` was compared object-by-object against one
built by `push` from `schema.ts` — 531 objects each, zero differences in either
direction.

## If you need the old history

`git log --follow webapp/src/lib/db/migrations-archive/<file>.sql`, or read the files
here directly. Do not add them back to a journal; they cannot be replayed on top of the
baseline.
