#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const runtimeAssetPatterns = [/^packages\/[^/]+\/prompts\/.+\.md$/, /^packages\/[^/]+\/skills\/.+\.md$/];
const identifierSkipPrefixes = ['docs/', 'examples/', 'python/ktx-sl/plans/', 'python/ktx-sl/openspec/'];
const identifierAllowPatterns = [
  /^packages\/cli\/src\/(?:index|managed-local-embeddings|managed-python-command|managed-python-daemon|managed-python-runtime|runtime)(?:\.test)?\.ts$/,
  /^scripts\/(?:build-public-npm-package|build-python-runtime-wheel|local-embeddings-runtime-smoke|package-artifacts|publish-public-npm-package|published-package-smoke|release-readiness)(?:\.test)?\.mjs$/,
];
const forbiddenIdentifierTerms = ['kae' + 'lio', 'Kae' + 'lio', 'KAE' + 'LIO_'];

const appImportPatterns = [
  {
    label: 'server source import',
    pattern: /(?:from\s+['"][^'"]*|import\s*\(\s*['"][^'"]*|import\s+['"][^'"]*)(?:@server\/|server\/src|(?:\.\.\/)+server\/src)/,
  },
  {
    label: 'frontend source import',
    pattern: /(?:from\s+['"][^'"]*|import\s*\(\s*['"][^'"]*|import\s+['"][^'"]*)(?:@frontend\/|frontend\/src|(?:\.\.\/)+frontend\/src)/,
  },
  {
    label: 'python service app import',
    pattern: /(?:from\s+['"][^'"]*|import\s*\(\s*['"][^'"]*|import\s+['"][^'"]*|from\s+)(?:python-service\/app|python_service\.app|app\.)/,
  },
];

const llmBoundaryPatterns = [
  {
    label: 'direct Anthropic provider construction',
    pattern: /\bcreateAnthropic\b/,
  },
  {
    label: 'direct Vertex Anthropic provider construction',
    pattern: /\bcreateVertexAnthropic\b/,
  },
  {
    label: 'direct AI SDK gateway construction',
    pattern: /\bcreateGateway\b/,
  },
  {
    label: 'direct AI SDK embedding execution',
    pattern: /\bembedMany\b/,
  },
  {
    label: 'legacy context LLM provider port',
    pattern: /\bLlmProviderPort\b/,
  },
  {
    label: 'legacy scan LLM provider port',
    pattern: /\bKtxScanLlmPort\b/,
  },
  {
    label: 'legacy gateway LLM provider helper',
    pattern: /\bcreateGatewayLlmProvider\b/,
  },
];

const contextProductionLlmBoundaryPatterns = [
  {
    label: 'context getModelByName call',
    pattern: /\.\s*getModelByName\s*\(/,
  },
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isCodeSource(relativePath) {
  return codeExtensions.has(path.extname(relativePath));
}

function isRuntimeAsset(relativePath) {
  return runtimeAssetPatterns.some((pattern) => pattern.test(relativePath));
}

function scansForAppImports(relativePath) {
  return isCodeSource(relativePath);
}

function scansForLlmBoundaries(relativePath) {
  return isCodeSource(relativePath) && relativePath.startsWith('packages/context/src/');
}

function isTestSource(relativePath) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

function scansForContextProductionLlmBoundaries(relativePath) {
  return scansForLlmBoundaries(relativePath) && !isTestSource(relativePath);
}

function scansForForbiddenIdentifiers(relativePath) {
  return isCodeSource(relativePath) || isRuntimeAsset(relativePath);
}

function skipsIdentifierScan(relativePath) {
  return identifierSkipPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function allowsForbiddenIdentifier(relativePath) {
  return identifierAllowPatterns.some((pattern) => pattern.test(relativePath));
}

export function scanFileContent(relativePath, content) {
  const normalizedPath = normalizePath(relativePath);
  const violations = [];

  if (scansForAppImports(normalizedPath)) {
    for (const appImportPattern of appImportPatterns) {
      if (appImportPattern.pattern.test(content)) {
        violations.push({
          file: normalizedPath,
          kind: 'app-import',
          message: `Forbidden ${appImportPattern.label}`,
        });
      }
    }
  }

  if (scansForLlmBoundaries(normalizedPath)) {
    for (const llmBoundaryPattern of llmBoundaryPatterns) {
      if (llmBoundaryPattern.pattern.test(content)) {
        violations.push({
          file: normalizedPath,
          kind: 'llm-boundary',
          message: `Forbidden ${llmBoundaryPattern.label}; use @ktx/llm`,
        });
      }
    }
  }

  if (scansForContextProductionLlmBoundaries(normalizedPath)) {
    for (const llmBoundaryPattern of contextProductionLlmBoundaryPatterns) {
      if (llmBoundaryPattern.pattern.test(content)) {
        violations.push({
          file: normalizedPath,
          kind: 'llm-boundary',
          message: `Forbidden ${llmBoundaryPattern.label}; use getModel(role) inside @ktx/context`,
        });
      }
    }
  }

  if (
    scansForForbiddenIdentifiers(normalizedPath) &&
    !skipsIdentifierScan(normalizedPath) &&
    !allowsForbiddenIdentifier(normalizedPath)
  ) {
    for (const term of forbiddenIdentifierTerms) {
      if (content.includes(term)) {
        violations.push({
          file: normalizedPath,
          kind: 'identifier',
          message: `Forbidden product identifier "${term}"`,
        });
      }
    }
  }

  return violations;
}

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.venv') {
        continue;
      }

      files.push(...(await collectFiles(rootDir, fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function collectViolations(rootDir) {
  const files = await collectFiles(rootDir);
  const violations = [];

  for (const file of files) {
    const relativePath = normalizePath(path.relative(rootDir, file));
    const content = await readFile(file, 'utf8');

    violations.push(...scanFileContent(relativePath, content));
  }

  return violations;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const violations = await collectViolations(rootDir);

  if (violations.length === 0) {
    process.stdout.write('ktx boundary check passed\n');
    return;
  }

  for (const violation of violations) {
    process.stderr.write(`${violation.file}: ${violation.message}\n`);
  }

  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
