import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const OPT_IN_MESSAGE =
  'Set KTX_RUN_CODEX_BACKEND_SMOKE=1 or pass --force to run the Codex backend live smoke.';

export function codexBackendSmokeOptIn(env = process.env, args = process.argv.slice(2)) {
  if (env.KTX_RUN_CODEX_BACKEND_SMOKE === '1' || args.includes('--force')) {
    return { run: true };
  }
  return { run: false, message: OPT_IN_MESSAGE };
}

async function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      timeout: options.timeoutMs ?? 300_000,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.message;
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
    };
  }
}

function requireSuccess(label, result) {
  if (result.code !== 0) {
    throw new Error(`${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function runSetupSmoke(projectDir) {
  const result = await run(
    'node',
    [
      join(ROOT_DIR, 'packages/cli/dist/bin.js'),
      'setup',
      '--project-dir',
      projectDir,
      '--llm-backend',
      'codex',
      '--llm-model',
      'gpt-5.3-codex',
      '--no-input',
      '--yes',
      '--skip-databases',
      '--skip-sources',
      '--skip-agents',
    ],
    { timeoutMs: 600_000 },
  );
  requireSuccess('ktx setup codex backend', result);
  if (!result.stdout.includes('LLM ready: yes (codex, gpt-5.3-codex)')) {
    throw new Error(`setup did not report Codex LLM readiness\nstdout:\n${result.stdout}`);
  }
}

async function runRuntimeSmoke(projectDir) {
  const runtimeUrl = pathToFileURL(join(ROOT_DIR, 'packages/cli/dist/context/llm/codex-runtime.js')).href;
  const zodUrl = pathToFileURL(join(ROOT_DIR, 'packages/cli/node_modules/zod/index.js')).href;
  const { CodexKtxLlmRuntime } = await import(runtimeUrl);
  const { z } = await import(zodUrl);
  const runtime = new CodexKtxLlmRuntime({
    projectDir,
    modelSlots: { default: 'gpt-5.3-codex' },
  });

  const text = await runtime.generateText({
    role: 'default',
    prompt: 'Reply with exactly: ktx_codex_text_ok',
  });
  if (text.trim() !== 'ktx_codex_text_ok') {
    throw new Error(`Codex text smoke returned unexpected text: ${text}`);
  }

  let toolCalls = 0;
  const loop = await runtime.runAgentLoop({
    modelRole: 'default',
    systemPrompt: 'You must use available tools when the user asks for a tool result.',
    userPrompt:
      'Call the echo_value tool with {"value":"ktx_codex_tool_ok"}, then finish after the tool returns.',
    toolSet: {
      echo_value: {
        name: 'echo_value',
        description: 'Return the provided value as markdown.',
        inputSchema: z.object({ value: z.string() }),
        execute: async (input) => {
          toolCalls += 1;
          return { markdown: `echo:${input.value}` };
        },
      },
    },
    stepBudget: 4,
    telemetryTags: {},
  });

  if (loop.stopReason !== 'natural') {
    throw new Error(`Codex tool smoke stopped with ${loop.stopReason}: ${loop.error?.message ?? 'no error'}`);
  }
  if (toolCalls !== 1) {
    throw new Error(`Expected Codex to call echo_value exactly once, got ${toolCalls}`);
  }
}

export async function runCodexBackendLiveSmoke() {
  const projectDir = await mkdtemp(join(tmpdir(), 'ktx-codex-backend-smoke-'));
  try {
    requireSuccess(
      'ktx build',
      await run('pnpm', ['--filter', '@kaelio/ktx', 'run', 'build'], { timeoutMs: 600_000 }),
    );
    await runSetupSmoke(projectDir);
    await runRuntimeSmoke(projectDir);
    process.stdout.write(`Codex backend live smoke passed in ${projectDir}\n`);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function main() {
  const optIn = codexBackendSmokeOptIn();
  if (!optIn.run) {
    process.stdout.write(`${optIn.message}\n`);
    return;
  }
  await runCodexBackendLiveSmoke();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
