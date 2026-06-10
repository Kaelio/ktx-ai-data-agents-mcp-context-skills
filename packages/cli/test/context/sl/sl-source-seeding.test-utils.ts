import type { KtxFileWriteResult } from '../../../src/context/core/file-store.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { slSourceFilePath } from '../../../src/context/sl/source-files.js';

/**
 * Seed a standalone/overlay semantic-layer file at the writer-derived path,
 * bypassing tool-level validation. Production writes go through
 * `SemanticLayerService.writeSource`; tests that only need a file on disk use
 * this instead.
 */
export async function seedSlSourceFile(
  project: KtxLocalProject,
  input: { connectionId: string; sourceName: string; yaml: string },
): Promise<KtxFileWriteResult> {
  return project.fileStore.writeFile(
    slSourceFilePath(input.connectionId, input.sourceName),
    input.yaml,
    'ktx',
    'ktx@example.com',
    `Seed semantic-layer source: ${input.connectionId}/${input.sourceName}`,
  );
}
