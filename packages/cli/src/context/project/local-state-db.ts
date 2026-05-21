import { join } from 'node:path';
import type { KtxLocalProject } from './project.js';

export function ktxLocalStateDbPath(project: Pick<KtxLocalProject, 'projectDir'>): string {
  return join(project.projectDir, '.ktx', 'db.sqlite');
}
