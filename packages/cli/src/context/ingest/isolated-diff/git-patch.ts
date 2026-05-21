import { assertSemanticLayerTargetPathsAllowed } from '../semantic-layer-target-policy.js';

/** @internal */
export const textArtifactRoots = ['wiki/', 'semantic-layer/'] as const;

export interface PatchTouchedPath {
  path: string;
  oldPath: string;
  newPath: string;
  mode: string | null;
  binary: boolean;
}

export interface PatchPolicyInput {
  unitKey: string;
  patch: string;
  slDisallowed: boolean;
  allowedTargetConnectionIds?: ReadonlySet<string>;
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

function isTextArtifactPath(path: string): boolean {
  return textArtifactRoots.some((root) => path.startsWith(root));
}

export function parsePatchTouchedPaths(patch: string): PatchTouchedPath[] {
  const lines = patch.split('\n');
  const entries: PatchTouchedPath[] = [];
  let current: PatchTouchedPath | null = null;

  const pushCurrent = () => {
    if (current) {
      entries.push(current);
    }
  };

  for (const line of lines) {
    const diffMatch = /^diff --git (.+) (.+)$/.exec(line);
    if (diffMatch) {
      pushCurrent();
      const oldPath = stripPrefix(diffMatch[1] ?? '');
      const newPath = stripPrefix(diffMatch[2] ?? '');
      current = {
        path: newPath === '/dev/null' ? oldPath : newPath,
        oldPath,
        newPath,
        mode: null,
        binary: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const indexMode = /^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/.exec(line);
    if (indexMode?.[1]) {
      current.mode = indexMode[1];
    }
    const newMode = /^new mode ([0-7]{6})$/.exec(line);
    if (newMode) {
      current.mode = newMode[1] ?? current.mode;
    }
    const newFileMode = /^new file mode ([0-7]{6})$/.exec(line);
    if (newFileMode) {
      current.mode = newFileMode[1] ?? current.mode;
    }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      current.binary = true;
    }
  }

  pushCurrent();
  return entries;
}

export function assertPatchAllowedForWorkUnit(input: PatchPolicyInput): PatchTouchedPath[] {
  const touched = parsePatchTouchedPaths(input.patch);
  if (input.allowedTargetConnectionIds) {
    assertSemanticLayerTargetPathsAllowed({
      paths: touched.map((entry) => entry.path),
      allowedConnectionIds: input.allowedTargetConnectionIds,
    });
  }
  for (const entry of touched) {
    if (input.slDisallowed && entry.path.startsWith('semantic-layer/')) {
      throw new Error(`slDisallowed WorkUnit ${input.unitKey} touched ${entry.path}`);
    }
    if (!isTextArtifactPath(entry.path)) {
      continue;
    }
    if (entry.binary) {
      throw new Error(`unexpected binary patch under ${entry.path}`);
    }
    if (entry.mode && entry.mode !== '100644') {
      throw new Error(`unexpected executable mode under ${entry.path}: ${entry.mode}`);
    }
  }
  return touched;
}
