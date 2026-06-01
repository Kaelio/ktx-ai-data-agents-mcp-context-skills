import assert from 'node:assert/strict';
import test from 'node:test';
import { codexBackendSmokeOptIn } from './codex-backend-live-smoke.mjs';

test('codex backend smoke stays disabled by default', () => {
  assert.deepEqual(codexBackendSmokeOptIn({}, []), {
    run: false,
    message: 'Set KTX_RUN_CODEX_BACKEND_SMOKE=1 or pass --force to run the Codex backend live smoke.',
  });
});

test('codex backend smoke runs with env opt-in', () => {
  assert.deepEqual(codexBackendSmokeOptIn({ KTX_RUN_CODEX_BACKEND_SMOKE: '1' }, []), { run: true });
});

test('codex backend smoke runs with force flag', () => {
  assert.deepEqual(codexBackendSmokeOptIn({}, ['--force']), { run: true });
});
