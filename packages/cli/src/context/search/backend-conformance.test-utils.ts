import type { SearchBackendCapabilities, SearchLaneStatus } from './types.js';

export interface SearchBackendConformanceLane {
  lane: string;
  status: SearchLaneStatus;
  reason?: string;
}

export interface SearchBackendConformanceDictionaryMatch {
  column: string;
  values: readonly string[];
  overflowCount?: number;
}

export interface SearchBackendConformanceResult {
  id: string;
  score: number;
  matchReasons: readonly string[];
  lanes?: readonly SearchBackendConformanceLane[];
  dictionaryMatches?: readonly SearchBackendConformanceDictionaryMatch[];
}

export interface ExpectedSearchBackendConformanceLane {
  status: SearchLaneStatus;
  reason?: string;
}

export interface AssertSearchBackendConformanceCaseInput {
  backendName: string;
  surface: string;
  caseName: string;
  results: readonly SearchBackendConformanceResult[];
  expectedTopIds: readonly string[];
  expectedReasonsById?: Record<string, readonly string[]>;
  expectedLanes?: Record<string, ExpectedSearchBackendConformanceLane>;
  expectedDictionaryMatchesById?: Record<string, readonly SearchBackendConformanceDictionaryMatch[]>;
}

export interface AssertSearchBackendCapabilitiesInput {
  backendName: string;
  capabilities: SearchBackendCapabilities;
  expected: Partial<SearchBackendCapabilities>;
}

function caseLabel(
  input: Pick<AssertSearchBackendConformanceCaseInput, 'backendName' | 'surface' | 'caseName'>,
): string {
  return `${input.backendName} ${input.surface} conformance case "${input.caseName}"`;
}

function fail(label: string, failures: string[]): never {
  throw new Error([`${label} failed:`, ...failures.map((failure) => `- ${failure}`)].join('\n'));
}

function dictionaryMatchKey(match: SearchBackendConformanceDictionaryMatch): string {
  const values = [...match.values].sort((left, right) => left.localeCompare(right)).join(',');
  return `${match.column}:${values}:${match.overflowCount ?? 0}`;
}

function dictionaryMatchKeys(matches: readonly SearchBackendConformanceDictionaryMatch[] | undefined): string[] {
  return (matches ?? []).map(dictionaryMatchKey).sort((left, right) => left.localeCompare(right));
}

export function assertSearchBackendConformanceCase(input: AssertSearchBackendConformanceCaseInput): void {
  const label = caseLabel(input);
  const failures: string[] = [];
  const topResults = input.results.slice(0, input.expectedTopIds.length);

  input.expectedTopIds.forEach((expectedId, index) => {
    const actualId = topResults[index]?.id;
    if (actualId !== expectedId) {
      failures.push(`expected result ${index + 1} to be ${expectedId}, got ${actualId ?? '<missing>'}`);
    }
  });

  const byId = new Map(input.results.map((result) => [result.id, result]));

  for (const expectedId of input.expectedTopIds) {
    const result = byId.get(expectedId);
    if (!result) {
      continue;
    }
    if (!Number.isFinite(result.score) || result.score <= 0) {
      failures.push(`expected ${expectedId} to have a positive finite score, got ${result.score}`);
    }
  }

  for (const [id, expectedReasons] of Object.entries(input.expectedReasonsById ?? {})) {
    const result = byId.get(id);
    if (!result) {
      failures.push(`expected reasons for ${id}, but the result was missing`);
      continue;
    }
    for (const reason of expectedReasons) {
      if (!result.matchReasons.includes(reason)) {
        failures.push(`expected ${id} to include match reason ${reason}, got [${result.matchReasons.join(', ')}]`);
      }
    }
  }

  const allLanes = input.results.flatMap((result) => result.lanes ?? []);
  for (const [lane, expected] of Object.entries(input.expectedLanes ?? {})) {
    const actual = allLanes.find((entry) => entry.lane === lane);
    if (!actual) {
      failures.push(`expected lane ${lane} to be reported`);
      continue;
    }
    if (actual.status !== expected.status) {
      failures.push(`expected lane ${lane} status ${expected.status}, got ${actual.status}`);
    }
    if (expected.reason !== undefined && actual.reason !== expected.reason) {
      failures.push(`expected lane ${lane} reason ${expected.reason}, got ${actual.reason ?? '<missing>'}`);
    }
  }

  for (const [id, expectedMatches] of Object.entries(input.expectedDictionaryMatchesById ?? {})) {
    const result = byId.get(id);
    if (!result) {
      failures.push(`expected dictionary matches for ${id}, but the result was missing`);
      continue;
    }

    const actualKeys = dictionaryMatchKeys(result.dictionaryMatches);
    for (const expectedKey of dictionaryMatchKeys(expectedMatches)) {
      if (!actualKeys.includes(expectedKey)) {
        failures.push(`expected ${id} dictionary evidence ${expectedKey}, got [${actualKeys.join(', ')}]`);
      }
    }
  }

  if (failures.length > 0) {
    fail(label, failures);
  }
}

export function assertSearchBackendCapabilities(input: AssertSearchBackendCapabilitiesInput): void {
  const failures: string[] = [];

  for (const [capability, expected] of Object.entries(input.expected) as Array<
    [keyof SearchBackendCapabilities, boolean]
  >) {
    const actual = input.capabilities[capability];
    if (actual !== expected) {
      failures.push(`expected ${capability}=${expected}, got ${actual}`);
    }
  }

  if (failures.length > 0) {
    fail(`${input.backendName} search backend capabilities`, failures);
  }
}
