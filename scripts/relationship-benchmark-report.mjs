import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KTX_RELATIONSHIP_BENCHMARK_MODES,
  buildKtxRelationshipBenchmarkReport,
  currentKtxRelationshipBenchmarkDetector,
  formatKtxRelationshipBenchmarkReportMarkdown,
  ktxRelationshipBenchmarkDetectorWithLlm,
  loadKtxRelationshipBenchmarkFixtures,
  runKtxRelationshipBenchmarkSuite,
} from '../packages/cli/dist/context/scan/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ktxRoot = resolve(scriptDir, '..');
const fixtureRoot = join(ktxRoot, 'packages/cli/src/test/fixtures/relationship-benchmarks');

async function buildDetector() {
  const backend = process.env.KTX_BENCHMARK_LLM_BACKEND;
  if (!backend || backend === 'none') {
    return currentKtxRelationshipBenchmarkDetector();
  }
  if (backend !== 'vertex') {
    throw new Error(`Unsupported KTX_BENCHMARK_LLM_BACKEND: ${backend}`);
  }
  const project = process.env.KTX_BENCHMARK_VERTEX_PROJECT;
  const location = process.env.KTX_BENCHMARK_VERTEX_LOCATION;
  const model = process.env.KTX_BENCHMARK_LLM_MODEL ?? 'claude-sonnet-4-6';
  if (!project || !location) {
    throw new Error('KTX_BENCHMARK_VERTEX_PROJECT and KTX_BENCHMARK_VERTEX_LOCATION are required for vertex backend');
  }
  const { createKtxLlmProvider } = await import('../packages/cli/dist/llm/index.js');
  const provider = createKtxLlmProvider({
    backend: 'vertex',
    vertex: { project, location },
    modelSlots: { default: model },
  });
  return ktxRelationshipBenchmarkDetectorWithLlm(provider);
}

const fixtures = await loadKtxRelationshipBenchmarkFixtures(fixtureRoot);
const detector = await buildDetector();
const suite = await runKtxRelationshipBenchmarkSuite({
  fixtures,
  detector,
});
const report = buildKtxRelationshipBenchmarkReport({
  fixtures,
  suite,
  modes: KTX_RELATIONSHIP_BENCHMARK_MODES,
});

process.stdout.write(formatKtxRelationshipBenchmarkReportMarkdown(report));
