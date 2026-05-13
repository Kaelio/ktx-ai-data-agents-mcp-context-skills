import { type SimpleGit, simpleGit } from 'simple-git';

const SANITIZED_GIT_ENV_KEYS = [
  'EDITOR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PAGER',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'GIT_WORK_TREE',
  'PAGER',
  'SSH_ASKPASS',
  'VISUAL',
] as const;

export function createSimpleGit(baseDir?: string): SimpleGit {
  const env = { ...process.env };
  for (const key of SANITIZED_GIT_ENV_KEYS) {
    delete env[key];
  }
  return simpleGit(baseDir).env(env);
}
