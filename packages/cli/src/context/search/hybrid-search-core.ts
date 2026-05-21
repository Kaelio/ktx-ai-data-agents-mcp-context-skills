import { defaultLaneCandidatePoolLimit, normalizeSearchQuery } from './query.js';
import { compareFusedSearchCandidates, DEFAULT_RRF_K, DEFAULT_SEARCH_LANE_WEIGHTS, rrfContribution } from './rrf.js';
import type {
  FusedSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  SearchCandidate,
  SearchCandidateGenerator,
  SearchLaneBreakdown,
  SearchLaneName,
  SearchLaneResult,
} from './types.js';

interface ExecutedLane {
  generator: SearchCandidateGenerator;
  result: SearchLaneResult;
}

function laneWeight(options: HybridSearchOptions, lane: SearchLaneName, generatorWeight?: number): number {
  return generatorWeight ?? options.laneWeights?.[lane] ?? DEFAULT_SEARCH_LANE_WEIGHTS[lane] ?? 1;
}

function normalizeCandidate(candidate: SearchCandidate, fallbackRank: number): SearchCandidate {
  const rank = Number.isFinite(candidate.rank) && candidate.rank > 0 ? Math.floor(candidate.rank) : fallbackRank;
  return { ...candidate, rank };
}

function bestCandidatesForLane(candidates: SearchCandidate[]): SearchCandidate[] {
  const byId = new Map<string, SearchCandidate>();
  candidates.forEach((candidate, index) => {
    const normalized = normalizeCandidate(candidate, index + 1);
    const existing = byId.get(normalized.id);
    if (
      !existing ||
      normalized.rank < existing.rank ||
      (normalized.rank === existing.rank && normalized.id.localeCompare(existing.id) < 0)
    ) {
      byId.set(normalized.id, normalized);
    }
  });

  return [...byId.values()].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

function failedLaneResult(error: unknown): SearchLaneResult {
  return {
    status: 'failed',
    candidates: [],
    reason: error instanceof Error ? error.message : String(error),
  };
}

export class HybridSearchCore {
  async search(options: HybridSearchOptions): Promise<HybridSearchResult> {
    const finalLimit = Math.max(1, options.limit);
    const requestedCandidatePoolLimit = options.candidatePoolLimit ?? defaultLaneCandidatePoolLimit(finalLimit);
    const normalizedQuery = normalizeSearchQuery(options.queryText);

    const executed = await Promise.all(
      options.generators.map(async (generator): Promise<ExecutedLane> => {
        try {
          const result = await generator.generate({
            queryText: options.queryText,
            normalizedQuery,
            finalLimit,
            laneCandidatePoolLimit: requestedCandidatePoolLimit,
          });
          return { generator, result };
        } catch (error) {
          return { generator, result: failedLaneResult(error) };
        }
      }),
    );

    const byId = new Map<string, FusedSearchCandidate>();
    const lanes: SearchLaneBreakdown[] = [];
    const rrfK = options.rrfK ?? DEFAULT_RRF_K;

    for (const { generator, result } of executed) {
      const weight = laneWeight(options, generator.lane, generator.weight);
      const status = result.status ?? 'available';
      const effectiveCandidatePoolLimit = result.effectiveCandidatePoolLimit ?? requestedCandidatePoolLimit;
      const laneCandidates = status === 'available' ? bestCandidatesForLane(result.candidates) : [];

      lanes.push({
        lane: generator.lane,
        status,
        requestedCandidatePoolLimit,
        effectiveCandidatePoolLimit,
        returnedCandidateCount: laneCandidates.length,
        weight,
        reason: result.reason,
      });

      if (status !== 'available') {
        continue;
      }

      for (const candidate of laneCandidates) {
        const existing =
          byId.get(candidate.id) ??
          ({
            id: candidate.id,
            score: 0,
            matchReasons: [],
            ranksByLane: {},
            rawScoresByLane: {},
            evidenceByLane: {},
          } satisfies FusedSearchCandidate);

        existing.score += rrfContribution(weight, candidate.rank, rrfK);
        existing.ranksByLane[generator.lane] = candidate.rank;
        if (candidate.rawScore !== undefined) {
          existing.rawScoresByLane[generator.lane] = candidate.rawScore;
        }
        const reason = candidate.matchReason ?? generator.lane;
        if (!existing.matchReasons.includes(reason)) {
          existing.matchReasons.push(reason);
        }
        if (candidate.evidence !== undefined) {
          existing.evidenceByLane[generator.lane] = [
            ...(existing.evidenceByLane[generator.lane] ?? []),
            candidate.evidence,
          ];
        }

        byId.set(candidate.id, existing);
      }
    }

    const results = [...byId.values()].sort(compareFusedSearchCandidates).slice(0, finalLimit);

    return {
      query: normalizedQuery,
      requestedLimit: finalLimit,
      requestedCandidatePoolLimit,
      results,
      lanes,
    };
  }
}
