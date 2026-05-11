import { describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from './config.js';
import {
  markKtxSetupStepComplete,
  mergeKtxSetupGitignoreEntries,
  setKtxSetupDatabaseConnectionIds,
} from './setup-config.js';

describe('KTX setup config helpers', () => {
  it('marks setup steps complete without duplicating existing state', () => {
    const config = buildDefaultKtxProjectConfig('warehouse');

    const withProject = markKtxSetupStepComplete(config, 'project');
    const withProjectAgain = markKtxSetupStepComplete(withProject, 'project');
    const withLlm = markKtxSetupStepComplete(withProjectAgain, 'llm');
    const withContext = markKtxSetupStepComplete(withLlm, 'context');

    expect(withProject.setup).toEqual({
      database_connection_ids: [],
      completed_steps: ['project'],
    });
    expect(withProjectAgain.setup?.completed_steps).toEqual(['project']);
    expect(withLlm.setup?.completed_steps).toEqual(['project', 'llm']);
    expect(withContext.setup?.completed_steps).toEqual(['project', 'llm', 'context']);
    expect(config.setup).toBeUndefined();
  });

  it('preserves database connection ids while marking a step complete', () => {
    const config = {
      ...buildDefaultKtxProjectConfig('warehouse'),
      setup: {
        database_connection_ids: ['warehouse'],
        completed_steps: ['databases'],
      },
    };

    expect(markKtxSetupStepComplete(config, 'project').setup).toEqual({
      database_connection_ids: ['warehouse'],
      completed_steps: ['databases', 'project'],
    });
  });

  it('sets setup database connection ids without duplicates', () => {
    const config = buildDefaultKtxProjectConfig('warehouse');

    const withDatabases = setKtxSetupDatabaseConnectionIds(config, ['warehouse', 'analytics', 'warehouse']);

    expect(withDatabases.setup).toEqual({
      database_connection_ids: ['warehouse', 'analytics'],
      completed_steps: [],
    });
    expect(config.setup).toBeUndefined();
  });

  it('marks databases complete only when requested', () => {
    const config = markKtxSetupStepComplete(buildDefaultKtxProjectConfig('warehouse'), 'project');

    const withDatabases = setKtxSetupDatabaseConnectionIds(config, ['warehouse'], { complete: true });
    const withDatabasesAgain = setKtxSetupDatabaseConnectionIds(withDatabases, ['warehouse'], { complete: true });

    expect(withDatabases.setup).toEqual({
      database_connection_ids: ['warehouse'],
      completed_steps: ['project', 'databases'],
    });
    expect(withDatabasesAgain.setup).toEqual(withDatabases.setup);
  });

  it('merges setup-local gitignore entries without removing existing lines', () => {
    expect(mergeKtxSetupGitignoreEntries('cache/\ndb.sqlite\n')).toBe(
      ['cache/', 'db.sqlite', 'db.sqlite-*', 'ingest-transcripts/', 'secrets/', 'setup/', 'agents/', ''].join('\n'),
    );
    expect(mergeKtxSetupGitignoreEntries('cache/\nsecrets/\n')).toBe(
      ['cache/', 'secrets/', 'db.sqlite', 'db.sqlite-*', 'ingest-transcripts/', 'setup/', 'agents/', ''].join('\n'),
    );
  });
});
