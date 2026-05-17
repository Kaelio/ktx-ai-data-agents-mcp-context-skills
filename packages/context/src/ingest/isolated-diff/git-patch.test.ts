import { describe, expect, it } from 'vitest';
import { assertPatchAllowedForWorkUnit, parsePatchTouchedPaths, textArtifactRoots } from './git-patch.js';

describe('isolated diff patch contract', () => {
  it('parses touched paths from no-rename git patches', () => {
    const patch = [
      'diff --git a/wiki/global/a.md b/wiki/global/a.md',
      'index 1111111..2222222 100644',
      '--- a/wiki/global/a.md',
      '+++ b/wiki/global/a.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/semantic-layer/c1/orders.yaml',
      '@@ -0,0 +1 @@',
      '+name: orders',
      '',
    ].join('\n');

    expect(parsePatchTouchedPaths(patch)).toEqual([
      {
        path: 'wiki/global/a.md',
        oldPath: 'wiki/global/a.md',
        newPath: 'wiki/global/a.md',
        mode: '100644',
        binary: false,
      },
      {
        path: 'semantic-layer/c1/orders.yaml',
        oldPath: 'semantic-layer/c1/orders.yaml',
        newPath: 'semantic-layer/c1/orders.yaml',
        mode: '100644',
        binary: false,
      },
    ]);
  });

  it('rejects semantic-layer paths for slDisallowed work units', () => {
    const patch = 'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml\nindex 1..2 100644\n';

    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'lookml-mismatch',
        patch,
        slDisallowed: true,
      }),
    ).toThrow(/slDisallowed WorkUnit lookml-mismatch touched semantic-layer\/c1\/orders.yaml/);
  });

  it('rejects executable and binary changes under known text artifact roots', () => {
    expect(textArtifactRoots).toEqual(['wiki/', 'semantic-layer/']);

    const executablePatch =
      'diff --git a/wiki/global/a.md b/wiki/global/a.md\nold mode 100644\nnew mode 100755\nindex 1..2\n';
    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'wu-1',
        patch: executablePatch,
        slDisallowed: false,
      }),
    ).toThrow(/unexpected executable mode under wiki\/global\/a.md/);

    const binaryPatch = [
      'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 0',
      '',
    ].join('\n');
    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'wu-2',
        patch: binaryPatch,
        slDisallowed: false,
      }),
    ).toThrow(/unexpected binary patch under semantic-layer\/c1\/orders.yaml/);
  });
});
