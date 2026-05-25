import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ktxRoot = fileURLToPath(new URL('../../../../..', import.meta.url));

function readKtxFile(relativePath: string): string {
  return readFileSync(join(ktxRoot, relativePath), 'utf8');
}

function readCliPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
} {
  return JSON.parse(readKtxFile('packages/cli/package.json'));
}

describe('PGlite hybrid search runtime boundary', () => {
  it('keeps PGlite packages as dev-only prototype dependencies', () => {
    const pkg = readCliPackageJson();

    expect(pkg.dependencies?.['@electric-sql/pglite']).toBeUndefined();
    expect(pkg.dependencies?.['@electric-sql/pglite-socket']).toBeUndefined();
    expect(pkg.devDependencies?.['@electric-sql/pglite']).toBeDefined();
    expect(pkg.devDependencies?.['@electric-sql/pglite-socket']).toBeDefined();
    expect(pkg.files).toEqual(['dist', 'assets']);
  });

  it('keeps PGlite prototypes out of public exports and production routing', () => {
    const pkg = readCliPackageJson();
    const packageExportKeys = Object.keys(pkg.exports ?? {});

    expect(packageExportKeys.filter((key) => key.toLowerCase().includes('pglite'))).toEqual([]);

    const productionRoutingFiles = [
      'packages/cli/src/sl.ts',
      'packages/cli/src/knowledge.ts',
      'packages/cli/src/context/mcp/local-project-ports.ts',
      'packages/cli/src/context/wiki/local-knowledge.ts',
      'packages/cli/src/context/ingest/context-evidence/sqlite-context-evidence-store.ts',
    ];

    for (const relativePath of productionRoutingFiles) {
      expect(readKtxFile(relativePath), relativePath).not.toMatch(
        /pglite-owner-prototype|pglite-sl-search-prototype|@electric-sql\/pglite/i,
      );
    }

    const localSlSource = readKtxFile('packages/cli/src/context/sl/local-sl.ts');
    expect(localSlSource).toContain("input.backend === 'pglite-owner-prototype'");
    expect(localSlSource).toContain('PGlite semantic-layer search prototype requires pglite owner-process options.');
    expect(localSlSource).toContain("await import('./pglite-sl-search-prototype.js')");
  });
});
