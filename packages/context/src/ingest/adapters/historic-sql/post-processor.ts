import type { IngestBundlePostProcessorInput, IngestBundlePostProcessorPort, IngestBundlePostProcessorResult } from '../../ports.js';
import { createSimpleGit } from '../../../core/git-env.js';
import { projectHistoricSqlEvidence } from './projection.js';

async function commitProjectionChanges(workdir: string): Promise<void> {
  const git = createSimpleGit(workdir);
  if (!(await git.checkIsRepo().catch(() => false))) {
    return;
  }
  const status = await git.status();
  const paths = status.files
    .map((file) => file.path)
    .filter((path) => path.startsWith('semantic-layer/') || path.startsWith('knowledge/global/historic-sql'));
  if (paths.length === 0) {
    return;
  }
  await git.add(paths);
  const staged = await git.diff(['--cached', '--name-only']);
  if (!staged.trim()) {
    return;
  }
  await git.commit('Project historic SQL evidence', { '--author': 'System User <system@example.com>' });
}

export class HistoricSqlProjectionPostProcessor implements IngestBundlePostProcessorPort {
  async run(input: IngestBundlePostProcessorInput): Promise<IngestBundlePostProcessorResult> {
    const projection = await projectHistoricSqlEvidence({
      workdir: input.workdir,
      connectionId: input.connectionId,
      syncId: input.syncId,
      runId: input.runId,
    });
    await commitProjectionChanges(input.workdir);
    return {
      result: projection,
      warnings: projection.warnings,
      errors: [],
      touchedSources: projection.touchedSources,
    };
  }
}
