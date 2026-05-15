# Research Agent MCP SQL Execution Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the parser-backed safety prerequisite and MCP `sql_execution` surface needed before the research-agent MCP tools can safely execute warehouse SQL.

**Architecture:** Keep connector `executeReadOnly()` as the execution path, but make the MCP adapter require a sqlglot-backed validator before calling any connector. Extend the existing Python SQL-analysis daemon with a read-only validation endpoint, expose it through the TypeScript SQL-analysis port, then register an MCP `sql_execution` tool only when the host provides that validator and a local scan connector factory.

**Tech Stack:** TypeScript, Vitest, Zod, Python, pytest, FastAPI, sqlglot, KTX MCP context ports, KTX scan connectors.

---

## Audit Summary

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented plans that overlap with the spec:

- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md` is implemented for the existing in-process MCP semantic runtime. Current evidence: `packages/context/src/mcp/context-tools.ts` registers `connection_*`, `wiki_*`, `sl_*`, `ingest_*`, and `scan_*` tools, and `packages/context/src/mcp/local-project-ports.ts` provides local ports for those surfaces.
- `docs/superpowers/plans/2026-05-12-warehouse-verification-tools.md` plus its May 12 and May 13 closure plans are implemented for ingest-only warehouse verification. Current evidence: `packages/context/src/ingest/tools/warehouse-verification/{discover-data,entity-details,sql-execution,warehouse-catalog.service}.ts` exist and are wired for ingest agents.

V1-blocking gaps remaining against the original spec:

- The public MCP research tools are not registered. `KtxMcpContextPorts` has no `discover`, `entityDetails`, `dictionarySearch`, or `sqlExecution` ports.
- The existing ingest `discover_data`, `entity_details`, and `sql_execution` tools use `connectionName`, `targets`, and `rowLimit`, and return markdown plus structured output. The spec requires MCP-shaped `connectionId`, `entities` / `maxRows`, and pure structured outputs.
- `sql_execution` cannot be safely exposed yet: `packages/context/src/connections/read-only-sql.ts` still uses first-token regex checks. The spec requires a sqlglot/AST-backed guard or connector-side read-only session before MCP registration.
- `packages/context/src/scan/entity-details.ts`, `packages/context/src/sl/dictionary-search.ts`, and `packages/context/src/search/discover.ts` do not exist.
- `WarehouseCatalogService` caches by connection only and does not invalidate when latest scan artifact identity advances.
- `dictionary_search` has no MCP service, no coverage metadata, and no per-connection miss reasons.
- `discover_data` has no unified ranked MCP result shape with `summary`, `snippet`, `matchedOn`, `kind`, `tableRef`, and RRF fusion across wiki, SL, and raw schema.
- `ktx mcp start|stop|status|logs` does not exist, and no HTTP Streamable MCP daemon exists.
- `ktx setup-agents` installs only the existing `ktx` CLI skill/rules; it does not install `ktx-research` or MCP client config entries/snippets.

Non-blocking or explicitly out-of-scope gaps:

- Python code execution over MCP.
- Stdio MCP transport.
- OS-level auto-start.
- Native TLS, audit logging, rate limiting, per-tool authorization, and multi-project daemon routing.
- Streaming SQL results.
- Full DDL-style ingest `entity_details` markdown formatting and hard write-time validation in ingest writer tools.

This plan covers the first prerequisite blocker: parser-backed SQL validation and MCP `sql_execution`. The remaining v1-blocking tool, daemon, and setup-agent work stays visible for subsequent plans.

## File Structure

Create no new files.

Modify these files:

- `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`: add a sqlglot-backed read-only SQL validator.
- `python/ktx-daemon/src/ktx_daemon/app.py`: expose `POST /sql/validate-read-only`.
- `python/ktx-daemon/tests/test_sql_analysis.py`: cover accepted SELECT/WITH and rejected CTE-DML, multi-statement, command, pragma, and parse-error payloads.
- `python/ktx-daemon/tests/test_app.py`: cover the new HTTP endpoint.
- `packages/context/src/sql-analysis/ports.ts`: add `validateReadOnly()` to `SqlAnalysisPort`.
- `packages/context/src/sql-analysis/http-sql-analysis-port.ts`: call `/sql/validate-read-only` and map its response.
- `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`: cover request and response mapping.
- `packages/context/src/mcp/types.ts`: add `KtxSqlExecutionMcpPort` and `sqlExecution` to `KtxMcpContextPorts`.
- `packages/context/src/mcp/context-tools.ts`: add the MCP `sql_execution` schema and registration.
- `packages/context/src/mcp/server.test.ts`: assert MCP registration and structured output for `sql_execution`.
- `packages/context/src/mcp/local-project-ports.ts`: expose local project SQL execution only when both `SqlAnalysisPort.validateReadOnly()` and a local scan connector factory are available.
- `packages/context/src/mcp/local-project-ports.test.ts`: cover validator success and validator rejection.

### Task 1: Add sqlglot Read-Only Validation

**Files:**
- Modify: `python/ktx-daemon/tests/test_sql_analysis.py`
- Modify: `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`
- Modify: `python/ktx-daemon/tests/test_app.py`
- Modify: `python/ktx-daemon/src/ktx_daemon/app.py`

- [ ] **Step 1: Write failing sqlglot validator tests**

In `python/ktx-daemon/tests/test_sql_analysis.py`, update the import block to include the new request model and function:

```python
from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchItem,
    AnalyzeSqlBatchRequest,
    ValidateReadOnlySqlRequest,
    _columns_from_nodes,
    analyze_sql_batch_response,
    validate_read_only_sql_response,
)
```

Add these tests after `test_columns_from_nodes_ignores_non_expression_clause_values`:

```python
def test_validate_read_only_sql_accepts_select_and_with_queries() -> None:
    select_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="select id, status from public.orders where status = 'paid'",
        )
    )
    with_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql=(
                "with paid as (select * from public.orders where status = 'paid') "
                "select count(*) from paid"
            ),
        )
    )

    assert select_response.ok is True
    assert select_response.error is None
    assert with_response.ok is True
    assert with_response.error is None


def test_validate_read_only_sql_rejects_cte_dml() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="with x as (insert into audit.events values (1) returning *) select * from x",
        )
    )

    assert response.ok is False
    assert response.error == "SQL contains read/write operation: Insert"


def test_validate_read_only_sql_rejects_multi_statement_payloads() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="select * from public.orders; delete from public.orders",
        )
    )

    assert response.ok is False
    assert response.error == "Only one SQL statement can be executed."


def test_validate_read_only_sql_rejects_commands_and_pragmas() -> None:
    command_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="postgres", sql="call refresh_stats()")
    )
    pragma_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="sqlite", sql="pragma table_info(users)")
    )

    assert command_response.ok is False
    assert command_response.error == "SQL contains read/write operation: Command"
    assert pragma_response.ok is False
    assert pragma_response.error == "SQL contains read/write operation: Pragma"


def test_validate_read_only_sql_reports_parse_errors() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="postgres", sql="select * from where")
    )

    assert response.ok is False
    assert response.error is not None
    assert "Invalid expression" in response.error
```

- [ ] **Step 2: Run failing Python validator tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py -q
```

Expected: FAIL with an import error for `ValidateReadOnlySqlRequest` or `validate_read_only_sql_response`.

- [ ] **Step 3: Implement the sqlglot validator**

In `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`, add this model after `AnalyzeSqlBatchResponse`:

```python
class ValidateReadOnlySqlRequest(BaseModel):
    dialect: str
    sql: str


class ValidateReadOnlySqlResponse(BaseModel):
    ok: bool
    error: str | None = None
```

Add this constant after the model definitions:

```python
_READ_ONLY_ROOT_TYPES = (exp.Select, exp.Union)
_READ_WRITE_NODE_TYPES = (
    exp.Alter,
    exp.Analyze,
    exp.Cache,
    exp.Command,
    exp.Commit,
    exp.Copy,
    exp.Create,
    exp.Delete,
    exp.Describe,
    exp.Drop,
    exp.Execute,
    exp.Grant,
    exp.Insert,
    exp.Merge,
    exp.Pragma,
    exp.Refresh,
    exp.Revoke,
    exp.Rollback,
    exp.Set,
    exp.Show,
    exp.Transaction,
    exp.TruncateTable,
    exp.Uncache,
    exp.Update,
    exp.Use,
)
```

Add this function after `_analyze_payload`:

```python
def validate_read_only_sql_response(
    request: ValidateReadOnlySqlRequest,
) -> ValidateReadOnlySqlResponse:
    try:
        statements = sqlglot.parse(request.sql, read=request.dialect)
    except sqlglot.errors.SqlglotError as exc:
        return ValidateReadOnlySqlResponse(ok=False, error=str(exc))

    if len(statements) != 1:
        return ValidateReadOnlySqlResponse(
            ok=False,
            error="Only one SQL statement can be executed.",
        )

    tree = statements[0]
    if tree is None:
        return ValidateReadOnlySqlResponse(ok=False, error="SQL did not parse to a statement.")
    if not isinstance(tree, _READ_ONLY_ROOT_TYPES):
        return ValidateReadOnlySqlResponse(
            ok=False,
            error=f"SQL contains read/write operation: {type(tree).__name__}",
        )

    for node in tree.walk():
        if isinstance(node, _READ_WRITE_NODE_TYPES):
            return ValidateReadOnlySqlResponse(
                ok=False,
                error=f"SQL contains read/write operation: {type(node).__name__}",
            )

    return ValidateReadOnlySqlResponse(ok=True, error=None)
```

- [ ] **Step 4: Run Python validator tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py -q
```

Expected: PASS.

- [ ] **Step 5: Write failing HTTP endpoint test**

In `python/ktx-daemon/tests/test_app.py`, add this test after `test_sql_parse_table_identifier_endpoint`:

```python
def test_sql_validate_read_only_endpoint() -> None:
    client = TestClient(create_app())

    ok_response = client.post(
        "/sql/validate-read-only",
        json={"dialect": "postgres", "sql": "select * from public.orders"},
    )
    bad_response = client.post(
        "/sql/validate-read-only",
        json={
            "dialect": "postgres",
            "sql": "with x as (insert into audit.events values (1) returning *) select * from x",
        },
    )

    assert ok_response.status_code == 200
    assert ok_response.json() == {"ok": True, "error": None}
    assert bad_response.status_code == 200
    assert bad_response.json() == {
        "ok": False,
        "error": "SQL contains read/write operation: Insert",
    }
```

- [ ] **Step 6: Run failing HTTP endpoint test**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py -q -k validate_read_only
```

Expected: FAIL with HTTP 404 for `/sql/validate-read-only`.

- [ ] **Step 7: Register the HTTP endpoint**

In `python/ktx-daemon/src/ktx_daemon/app.py`, update the SQL-analysis import to include the new symbols:

```python
from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchRequest,
    AnalyzeSqlBatchResponse,
    ValidateReadOnlySqlRequest,
    ValidateReadOnlySqlResponse,
    analyze_sql_batch_response,
    validate_read_only_sql_response,
)
```

Add this endpoint immediately before the existing `@app.post("/sql/analyze-batch", ...)` route:

```python
    @app.post("/sql/validate-read-only", response_model=ValidateReadOnlySqlResponse)
    async def sql_validate_read_only(
        request: ValidateReadOnlySqlRequest,
    ) -> ValidateReadOnlySqlResponse:
        try:
            return validate_read_only_sql_response(request)
        except Exception as error:
            logger.exception("SQL read-only validation failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"SQL read-only validation failed: {error}",
            ) from error
```

- [ ] **Step 8: Run Python HTTP endpoint test**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py -q -k validate_read_only
```

Expected: PASS.

- [ ] **Step 9: Commit Python validator**

Run:

```bash
git add python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py
git commit -m "feat(daemon): validate read-only SQL with sqlglot"
```

### Task 2: Expose Read-Only Validation Through the TypeScript SQL-Analysis Port

**Files:**
- Modify: `packages/context/src/sql-analysis/ports.ts`
- Modify: `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`
- Modify: `packages/context/src/sql-analysis/http-sql-analysis-port.ts`

- [ ] **Step 1: Add the port contract**

In `packages/context/src/sql-analysis/ports.ts`, add this interface after `SqlAnalysisBatchResult`:

```typescript
export interface SqlReadOnlyValidationResult {
  ok: boolean;
  error?: string | null;
}
```

Update `SqlAnalysisPort` to include the new method:

```typescript
export interface SqlAnalysisPort {
  analyzeForFingerprint(sql: string, dialect: SqlAnalysisDialect): Promise<SqlAnalysisFingerprintResult>;
  analyzeBatch(
    items: SqlAnalysisBatchItem[],
    dialect: SqlAnalysisDialect,
  ): Promise<Map<string, SqlAnalysisBatchResult>>;
  validateReadOnly(sql: string, dialect: SqlAnalysisDialect): Promise<SqlReadOnlyValidationResult>;
}
```

- [ ] **Step 2: Write failing HTTP port tests**

In `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`, add this test inside the existing `describe('createHttpSqlAnalysisPort', ...)` block:

```typescript
  it('maps read-only SQL validation responses', async () => {
    const requests: Array<{ path: string; payload: Record<string, unknown> }> = [];
    const port = createHttpSqlAnalysisPort({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson: async (path, payload) => {
        requests.push({ path, payload });
        return { ok: false, error: 'SQL contains read/write operation: Insert' };
      },
    });

    await expect(port.validateReadOnly('with x as (insert into t values (1)) select * from x', 'postgres')).resolves.toEqual({
      ok: false,
      error: 'SQL contains read/write operation: Insert',
    });
    expect(requests).toEqual([
      {
        path: '/sql/validate-read-only',
        payload: {
          dialect: 'postgres',
          sql: 'with x as (insert into t values (1)) select * from x',
        },
      },
    ]);
  });
```

Add this test after it:

```typescript
  it('rejects malformed read-only validation responses', async () => {
    const port = createHttpSqlAnalysisPort({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson: async () => ({ ok: 'yes' }),
    });

    await expect(port.validateReadOnly('select 1', 'postgres')).rejects.toThrow(
      'sql analysis response is missing boolean field ok',
    );
  });
```

- [ ] **Step 3: Run failing HTTP port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sql-analysis/http-sql-analysis-port.test.ts
```

Expected: FAIL because `validateReadOnly` is not implemented.

- [ ] **Step 4: Implement HTTP response mapping**

In `packages/context/src/sql-analysis/http-sql-analysis-port.ts`, update the type import to include `SqlReadOnlyValidationResult`:

```typescript
  SqlReadOnlyValidationResult,
```

Add this helper after `requiredStringArray`:

```typescript
function requiredBoolean(raw: Record<string, unknown>, field: string): boolean {
  const value = raw[field];
  if (typeof value !== 'boolean') {
    throw new Error(`sql analysis response is missing boolean field ${field}`);
  }
  return value;
}
```

Add this mapper after `mapBatchResponse`:

```typescript
function mapReadOnlyValidation(raw: Record<string, unknown>): SqlReadOnlyValidationResult {
  const error = optionalString(raw, 'error');
  return {
    ok: requiredBoolean(raw, 'ok'),
    ...(error !== undefined ? { error } : {}),
  };
}
```

Add this method to the object returned by `createHttpSqlAnalysisPort`:

```typescript
    async validateReadOnly(sql: string, dialect: SqlAnalysisDialect) {
      const raw = await requestJson('/sql/validate-read-only', {
        dialect,
        sql,
      });
      return mapReadOnlyValidation(raw);
    },
```

- [ ] **Step 5: Run HTTP port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sql-analysis/http-sql-analysis-port.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit TypeScript SQL-analysis port**

Run:

```bash
git add packages/context/src/sql-analysis/ports.ts packages/context/src/sql-analysis/http-sql-analysis-port.ts packages/context/src/sql-analysis/http-sql-analysis-port.test.ts
git commit -m "feat(context): expose read-only SQL validation port"
```

### Task 3: Register the MCP `sql_execution` Tool Contract

**Files:**
- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.test.ts`

- [ ] **Step 1: Add the MCP SQL execution port types**

In `packages/context/src/mcp/types.ts`, add these interfaces immediately before `KtxMcpContextPorts`:

```typescript
export interface KtxSqlExecutionResponse {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface KtxSqlExecutionMcpPort {
  execute(input: { connectionId: string; sql: string; maxRows: number }): Promise<KtxSqlExecutionResponse>;
}
```

Then add the new optional port to `KtxMcpContextPorts`:

```typescript
  sqlExecution?: KtxSqlExecutionMcpPort;
```

- [ ] **Step 2: Write failing MCP registration test**

In `packages/context/src/mcp/server.test.ts`, update the type import from `./types.js` to include `KtxSqlExecutionMcpPort`.

Add this test in `describe('createKtxMcpServer', ...)` after the existing connection-list registration test:

```typescript
  it('registers parser-gated sql_execution when the host provides a SQL execution port', async () => {
    const fake = makeFakeServer();
    const sqlExecution: KtxSqlExecutionMcpPort = {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue({
        headers: ['status', 'count'],
        headerTypes: ['text', 'bigint'],
        rows: [['paid', 42]],
        rowCount: 1,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: {
        sqlExecution,
      },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['sql_execution']);
    await expect(
      getTool(fake.tools, 'sql_execution').handler({
        connectionId: 'warehouse',
        sql: 'select status, count(*) from public.orders group by status',
        maxRows: 50,
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              headers: ['status', 'count'],
              headerTypes: ['text', 'bigint'],
              rows: [['paid', 42]],
              rowCount: 1,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        headers: ['status', 'count'],
        headerTypes: ['text', 'bigint'],
        rows: [['paid', 42]],
        rowCount: 1,
      },
    });
    expect(sqlExecution.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      sql: 'select status, count(*) from public.orders group by status',
      maxRows: 50,
    });
  });
```

- [ ] **Step 3: Run failing MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t sql_execution
```

Expected: FAIL because `sql_execution` is not registered.

- [ ] **Step 4: Add the MCP schema and registration**

In `packages/context/src/mcp/context-tools.ts`, add this schema after `scanArtifactReadSchema`:

```typescript
const sqlExecutionSchema = z.object({
  connectionId: connectionIdSchema,
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional(),
});
```

Add this registration block in `registerKtxContextTools`, after the semantic-layer block and before the ingest block:

```typescript
  if (ports.sqlExecution) {
    const sqlExecution = ports.sqlExecution;
    registerParsedTool(
      server,
      'sql_execution',
      {
        title: 'SQL Execution',
        description:
          'Execute one parser-validated read-only SQL query against a configured KTX connection and return structured rows.',
        inputSchema: sqlExecutionSchema.shape,
      },
      sqlExecutionSchema,
      async (input) => {
        try {
          return jsonToolResult(
            await sqlExecution.execute({
              connectionId: input.connectionId,
              sql: input.sql,
              maxRows: input.maxRows ?? 1000,
            }),
          );
        } catch (error) {
          return jsonErrorToolResult(error instanceof Error ? error.message : String(error));
        }
      },
    );
  }
```

- [ ] **Step 5: Run MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t sql_execution
```

Expected: PASS.

- [ ] **Step 6: Commit MCP tool contract**

Run:

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts
git commit -m "feat(context): register MCP sql execution tool"
```

### Task 4: Implement Local Project SQL Execution With Parser Validation

**Files:**
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing local-port success test**

In `packages/context/src/mcp/local-project-ports.test.ts`, update the imports from `../scan/index.js` to include `type KtxQueryResult`.

Replace the existing `testConnector` helper with this version so tests can opt into read-only SQL:

```typescript
  function testConnector(
    snapshot = testSnapshot(),
    queryResult?: KtxQueryResult,
  ): KtxScanConnector {
    return {
      id: `test:${snapshot.connectionId}`,
      driver: snapshot.driver,
      capabilities: createKtxConnectorCapabilities({ readOnlySql: queryResult !== undefined }),
      introspect: vi.fn(async () => snapshot),
      executeReadOnly: queryResult === undefined ? undefined : vi.fn(async () => queryResult),
      cleanup: vi.fn(async () => {}),
    };
  }
```

Add this test after `tests a local project connection through the native scan connector factory`:

```typescript
  it('executes MCP SQL only after parser-backed validation passes', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const createConnector = vi.fn(async () => connector);
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector,
      },
    });

    await expect(
      ports.sqlExecution?.execute({
        connectionId: 'warehouse',
        sql: 'select id from public.orders',
        maxRows: 5,
      }),
    ).resolves.toEqual({
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      rowCount: 1,
    });
    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select id from public.orders', 'postgres');
    expect(createConnector).toHaveBeenCalledWith('warehouse');
    expect(connector.executeReadOnly).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        sql: 'select id from public.orders',
        maxRows: 5,
      },
      { runId: 'mcp-sql-execution' },
    );
    expect(connector.cleanup).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Write failing local-port rejection test**

Add this test after the success test:

```typescript
  it('rejects MCP SQL before connector execution when parser validation fails', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({
        ok: false,
        error: 'SQL contains read/write operation: Insert',
      })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector: vi.fn(async () => connector),
      },
    });

    await expect(
      ports.sqlExecution?.execute({
        connectionId: 'warehouse',
        sql: 'with x as (insert into t values (1) returning *) select * from x',
        maxRows: 1000,
      }),
    ).rejects.toThrow('SQL contains read/write operation: Insert');
    expect(connector.executeReadOnly).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run failing local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "MCP SQL"
```

Expected: FAIL because `CreateLocalProjectMcpContextPortsOptions` has no `sqlAnalysis` option and no `sqlExecution` port.

- [ ] **Step 4: Add SQL-analysis option and helper imports**

In `packages/context/src/mcp/local-project-ports.ts`, add this import with the other context imports:

```typescript
import type { SqlAnalysisDialect, SqlAnalysisPort } from '../sql-analysis/index.js';
```

Add `sqlAnalysis` to `CreateLocalProjectMcpContextPortsOptions`:

```typescript
  sqlAnalysis?: SqlAnalysisPort;
```

Add this helper near `dialectForDriver`:

```typescript
function sqlAnalysisDialectForDriver(driver: string | undefined): SqlAnalysisDialect {
  return dialectForDriver(driver) as SqlAnalysisDialect;
}
```

- [ ] **Step 5: Implement the local SQL execution port**

In `packages/context/src/mcp/local-project-ports.ts`, add this function before `createLocalProjectMcpContextPorts`:

```typescript
async function executeValidatedReadOnlySql(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  input: { connectionId: string; sql: string; maxRows: number },
): Promise<{ headers: string[]; headerTypes?: string[]; rows: unknown[][]; rowCount: number }> {
  const connectionId = assertSafeConnectionId(input.connectionId);
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  if (!options.sqlAnalysis) {
    throw new Error('sql_execution requires parser-backed SQL validation.');
  }
  const validation = await options.sqlAnalysis.validateReadOnly(
    input.sql,
    sqlAnalysisDialectForDriver(connection.driver),
  );
  if (!validation.ok) {
    throw new Error(validation.error ?? 'SQL is not read-only.');
  }
  const createConnector = options.localScan?.createConnector;
  if (!createConnector) {
    throw new Error('sql_execution requires a local scan connector factory.');
  }

  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(connectionId);
    if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
      throw new Error(`Connection "${connectionId}" does not support read-only SQL execution.`);
    }
    const result = await connector.executeReadOnly(
      {
        connectionId,
        sql: input.sql,
        maxRows: input.maxRows,
      },
      { runId: 'mcp-sql-execution' },
    );
    return {
      headers: result.headers,
      ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  } finally {
    await cleanupConnector(connector);
  }
}
```

In `createLocalProjectMcpContextPorts`, add this conditional block immediately after the initial `ports` object is created and before the existing `if (options.localIngest)` block:

```typescript
  if (options.sqlAnalysis && options.localScan?.createConnector) {
    ports.sqlExecution = {
      async execute(input) {
        return executeValidatedReadOnlySql(project, options, input);
      },
    };
  }
```

- [ ] **Step 6: Run local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "MCP SQL"
```

Expected: PASS.

- [ ] **Step 7: Commit local MCP SQL execution**

Run:

```bash
git add packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat(context): execute MCP SQL through validated connector path"
```

### Task 5: Verification

**Files:**
- Verify: all modified files from Tasks 1-4

- [ ] **Step 1: Run Python SQL-analysis and app tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py -q
```

Expected: PASS.

- [ ] **Step 2: Run focused TypeScript tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sql-analysis/http-sql-analysis-port.test.ts src/mcp/server.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run Python pre-commit on changed Python files**

Run:

```bash
source .venv/bin/activate && uv run pre-commit run --files python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py
```

Expected: PASS. If the repository has no usable pre-commit configuration in the active environment, record the exact error and keep the pytest results above as the closest Python verification.

- [ ] **Step 5: Confirm the remaining v1 blockers are unchanged**

Run:

```bash
test -e packages/context/src/scan/entity-details.ts; printf 'entity-details:%s\n' "$?"
test -e packages/context/src/sl/dictionary-search.ts; printf 'dictionary-search:%s\n' "$?"
test -e packages/context/src/search/discover.ts; printf 'discover:%s\n' "$?"
test -e packages/cli/src/commands/mcp-commands.ts; printf 'mcp-commands:%s\n' "$?"
test -e packages/cli/src/skills/research/SKILL.md; printf 'research-skill:%s\n' "$?"
```

Expected:

```text
entity-details:1
dictionary-search:1
discover:1
mcp-commands:1
research-skill:1
```

These `1` exit-code markers confirm this plan landed only the SQL execution foundation and did not silently claim the remaining research-tool, daemon, or setup-agent v1 work.

- [ ] **Step 6: Commit verification notes if any test docs changed**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes after the task commits. If verification required a small documentation note, commit only that note with:

```bash
git add docs/superpowers/plans/2026-05-14-research-agent-mcp-sql-execution-foundation.md
git commit -m "docs: record research MCP SQL execution plan"
```
