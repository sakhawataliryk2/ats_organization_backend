# Reusable Business Record Numbers

## Rules

- **Primary Key (id)** is used for all fetching, updating, deleting, and relations. Do not change this.
- **record_number** is for **display only**. It is reusable after HARD delete.
- Never fetch by `record_number`, never use it in foreign keys, never expose it as system identity.

## Display Format

When returning data to the frontend, display format is:

```
prefix + '-' + record_number
```

Examples: `T-15`, `J-4`, `O-22`.

Prefixes are defined in the `modules` table (name, prefix). The service exports `formatDisplayRecordNumber(moduleType, recordNumber)` for use in API responses if you want to add a `display_record_number` field.

## Allocation (Create)

- Run inside the same transaction as the INSERT.
- Call `allocateRecordNumber(client, 'task' | 'job' | 'organization')` to get the next `record_number`.
- Insert the row with that `record_number`.

## Release (Hard Delete Only)

- On **permanent** delete only (not soft/archive): before `DELETE FROM ...`, call `releaseRecordNumber(client, moduleType, record_number)` so the number can be reused.

## Migration

Run once (or let the app run it on first init):

```bash
psql -f migrations/reusable_record_numbers.sql
```

Or the app runs it automatically when Task/Job/Organization tables are first initialized (idempotent).
