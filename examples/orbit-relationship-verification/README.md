# Orbit-style relationship discovery verification

This **ktx** project backs the default `relationships:verify-orbit` command. It uses
the checked-in Orbit-style SQLite fixture from the relationship discovery
benchmark corpus, with no declared primary keys or foreign keys in the database
schema.

Run from the **ktx** workspace root:

```bash
pnpm run relationships:verify-orbit
```

Expected relationship summary:

```text
Accepted: 9
Review: 0
Rejected: 0
Skipped: 0
```

The command refreshes:

```text
examples/orbit-relationship-verification/reports/orbit-verification.md
```

Use a real local Orbit project by overriding the project directory:

```bash
KTX_PROJECT_DIR=/path/to/orbit-project pnpm run relationships:verify-orbit
```
