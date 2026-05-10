import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('Conductor workspace scripts', () => {
  it('registers setup and run scripts in nonconcurrent mode', async () => {
    const manifest = JSON.parse(await readText('conductor.json'));

    assert.deepEqual(manifest.scripts, {
      setup: 'bash scripts/conductor-setup.sh',
      run: 'bash scripts/conductor-run.sh',
    });
    assert.equal(manifest.runScriptMode, 'nonconcurrent');
  });

  it('sets up exact uv, Python packages, JS packages, and the built CLI', async () => {
    const setupScript = await readText('scripts/conductor-setup.sh');

    assert.match(setupScript, /read_required_uv_version\(\)/);
    assert.match(setupScript, /\.context\/bin\/uv-\$required_version/);
    assert.match(setupScript, /uv sync --all-packages --all-groups/);
    assert.match(setupScript, /pnpm install --frozen-lockfile --prefer-offline/);
    assert.match(setupScript, /pnpm run native:rebuild/);
    assert.match(setupScript, /pnpm run build/);
    assert.match(setupScript, /packages\/cli\/dist\/bin\.js dev doctor setup --no-input/);
  });

  it('runs the KTX daemon on the documented fixed local port', async () => {
    const runScript = await readText('scripts/conductor-run.sh');
    const legacyServerPackagePattern = new RegExp(`frontend|@${['kae', 'lio'].join('')}/server|python-service|npx`);

    assert.match(runScript, /pnpm run build/);
    assert.match(runScript, /source \.venv\/bin\/activate/);
    assert.match(runScript, /uv run ktx-daemon serve-http --host 127\.0\.0\.1 --port 8765/);
    assert.doesNotMatch(runScript, legacyServerPackagePattern);
  });
});
