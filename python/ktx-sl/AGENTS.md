# Semantic Layer Engine

Python semantic layer that generates SQL from structured JSON queries. No `from` clause - sources are inferred from fully-qualified field names (`source.column`).

## Quick Start

```bash
uv run pytest -q                    # run all tests
uv run python -m semantic_layer.cli --help
```

## Testing Corner Cases via CLI

Use `--model` to pass a self-contained YAML model (list of source definitions) instead of a directory. This lets you test any join topology or edge case without creating files.

### 1. Create an inline model file

```yaml
# /tmp/model.yaml - a YAML list of source definitions
- name: orders
  table: public.orders
  grain: [id]
  columns:
    - {name: id, type: number}
    - {name: amount, type: number}
    - {name: status, type: string}
  joins:
    - to: customers
      "on": "customer_id = customers.id"
      relationship: many_to_one
  measures:
    - {name: revenue, expr: "sum(amount)", filter: "status != 'refunded'"}

- name: customers
  table: public.customers
  grain: [id]
  columns:
    - {name: id, type: number}
    - {name: segment, type: string}
```

### 2. Run queries against it

```bash
# Basic query
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":["sum(orders.amount)"],"dimensions":["customers.segment"]}'

# Pre-defined measure + filter
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":["orders.revenue"],"dimensions":["orders.status"],"filters":["orders.status != '"'"'cancelled'"'"'"]}'

# Show resolved plan alongside SQL
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":["orders.revenue"],"dimensions":["customers.segment"]}' --plan

# Validate without generating SQL
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":["orders.revenue"],"dimensions":["customers.segment"]}' --suggest
```

### 3. Test fan-out / chasm traps

Add multiple measure sources that fan out from a shared dimension hub:

```yaml
# Two independent fact tables joining to the same dimension
- name: hub
  table: public.hub
  grain: [id]
  columns: [{name: id, type: number}, {name: segment, type: string}]

- name: fact_a
  table: public.fact_a
  grain: [id]
  columns: [{name: id, type: number}, {name: hub_id, type: number}, {name: val, type: number}]
  joins: [{to: hub, "on": "hub_id = hub.id", relationship: many_to_one}]

- name: fact_b
  table: public.fact_b
  grain: [id]
  columns: [{name: id, type: number}, {name: hub_id, type: number}, {name: val, type: number}]
  joins: [{to: hub, "on": "hub_id = hub.id", relationship: many_to_one}]
```

```bash
# This triggers aggregate locality (separate CTEs per fact table, FULL JOIN)
uv run python -m semantic_layer.cli --model /tmp/chasm.yaml \
  -q '{"measures":["sum(fact_a.val)","sum(fact_b.val)"],"dimensions":["hub.segment"]}'
```

### 4. Test derived measures

```bash
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":[{"expr":"sum(orders.amount)","name":"total"},{"expr":"count(orders.id)","name":"cnt"},{"expr":"total / cnt","name":"avg_order"}],"dimensions":["customers.segment"]}'
```

### 5. Test dialects

```bash
uv run python -m semantic_layer.cli --model /tmp/model.yaml \
  -q '{"measures":["sum(orders.amount)"],"dimensions":["customers.segment"]}' --dialect bigquery
```

### 6. Useful flags

| Flag | Purpose |
|------|---------|
| `--model FILE` | Single YAML file with all sources (alternative to `--sources DIR`) |
| `--plan` | Show resolved plan + SQL |
| `--plan-only` | Show plan without SQL |
| `--suggest` | Validate query, show suggestions on failure |
| `--list-sources` | Print all sources, columns, measures, joins |
| `--dialect X` | postgres (default), bigquery, snowflake, duckdb, mysql |
| `--compact` | SQL without header comment |
| `-q JSON` | Pass query as JSON string |
| `--json` | Read JSON query from stdin |

## Coding Guidelines

### Expression handling - always use sqlglot AST, never regex on SQL

- **Parse expressions** with `sqlglot.parse_one(f"SELECT {expr}")` and walk/transform the AST. Never use `str.replace()`, `re.sub()`, or string splitting on SQL fragments - these corrupt string literals, aliases, and nested expressions.
- **Quote reserved words first**: always call `quote_reserved_identifiers(expr)` before passing to `sqlglot.parse_one()`. Column/source names like `group`, `key`, `order` will fail to parse otherwise.
- **Use the parse cache** in `parser.py` (`ExpressionParser._parse_as_select()`) for read-only AST walks. Direct `sqlglot.parse_one()` calls are fine when you need to `.transform()` the tree.
- **Regex is fine for non-SQL tasks**: sanitizing alias names, masking string literals before parse, etc. The rule is: don't use regex to interpret SQL structure.

### Error handling

- Never use bare `except Exception: pass`. At minimum add `logger.debug(...)` so failures are observable. Prefer catching `sqlglot.errors.ParseError` specifically.
- Regex fallback paths in generator.py exist for edge cases where sqlglot can't parse user-provided SQL sources. These are acceptable as last-resort fallbacks with logging, not as primary code paths.

### SQL generation strategy

- **Write postgres, transpile on output.** All SQL is generated as postgres dialect. `_transpile()` converts to the target dialect at the very end. Never add dialect-specific SQL generation logic.
- **f-strings for SQL skeleton** (`SELECT/FROM/JOIN/GROUP BY`) are fine and readable. Use sqlglot AST only for expression-level transformations (substitution, function translation, filter rewriting).
- **Don't build SQL via sqlglot node construction** (`exp.Select().from_(...)`). It's harder to read and debug than f-strings for structural SQL.

### Testing

- Run `uv run pytest -q` after every change. All tests must pass.
- Test CLI queries with `--model /tmp/model.yaml` for quick iteration on edge cases (see examples above).
- When adding expression handling logic, test with reserved-word identifiers (`group.key`, `order.select`) and string literals containing dots (`status = 'group.value'`).

## Project Structure

```
semantic_layer/
  models.py      # Pydantic data models (sources, queries, plans, results)
  loader.py      # YAML source file loader
  graph.py       # Bidirectional join graph with Dijkstra + Steiner tree
  parser.py      # Expression parser (source refs, aggregate detection)
  planner.py     # 12-step query planning pipeline
  generator.py   # SQL generation (simple path + aggregate locality)
  engine.py      # Orchestrator tying loader/graph/planner/generator
  cli.py         # CLI entry point
sources/
  ecommerce/     # Test fixtures (6 YAML source definitions)
tests/           # 353 tests
```
