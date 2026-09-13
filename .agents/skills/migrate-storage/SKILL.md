---
name: migrate-storage
description: Change the do-sift database schema or indexes safely — write forward migrations, check compatibility, and document backup/restore implications. Use whenever a task touches migrations/, schema SQL, indexes, or the storage plugin.
---

# migrate-storage

## Procedure

1. Read `plans/adr/0002-libsql-and-storage.md` and the existing
   `migrations/` directory. Find the highest migration number; never edit an
   applied migration — add a new one.
2. Prefer expand/contract: add new tables/columns, backfill, then (in a later
   migration) remove. Destructive steps require a separate approval per
   AGENTS.md boundaries.
3. Every migration is explicit SQL with a stable numbered filename and an
   entry in the schema-version chain. No ORM auto-sync.
4. Update repository code + types together with the migration.
5. Tests: fresh-DB apply (all migrations in order), apply-over-old-fixture
   (old data survives), and rollback story documented (what a downgrade
   needs — even if downgrade is "restore from backup").
6. State the backup/restore implication in the task evidence: what to back up
   first, what breaks on rollback, expected DB size delta.
7. Run `npm run check`; record evidence in the plan file.

## Rules

- Owner scoping: any new owner-relevant table/column must keep owner-scoped
  queries (cross-owner fixture test must stay green).
- Vector/embedding columns must record model id, dimension, and revision —
  never mix incompatible vectors.
