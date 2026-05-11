# Orbit-style relationship discovery verification

This KTX project backs the default `relationships:verify-orbit` command. It uses
the checked-in Orbit-style SQLite fixture from the relationship discovery
benchmark corpus, with no declared primary keys or foreign keys in the database
schema.

Run from the KTX workspace root:

```bash
pnpm run relationships:verify-orbit
```

The command refreshes:

```text
examples/orbit-relationship-verification/reports/orbit-verification.md
```

Use a real local Orbit project by overriding the project directory:

```bash
KTX_ORBIT_PROJECT_DIR=/path/to/orbit-project pnpm run relationships:verify-orbit
```
