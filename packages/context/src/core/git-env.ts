import { simpleGit, type SimpleGit } from 'simple-git';

const GIT_HOOK_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_PAGER',
  'PAGER',
  'VISUAL',
  'EDITOR',
] as const;

function sanitizedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of GIT_HOOK_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function createSimpleGit(baseDir: string): SimpleGit {
  return simpleGit({ baseDir, unsafe: { allowUnsafeAskPass: true } }).env(sanitizedGitEnv());
}
