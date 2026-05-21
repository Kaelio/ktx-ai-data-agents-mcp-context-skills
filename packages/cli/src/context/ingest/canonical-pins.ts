import type { StageIndex } from './stages/stage-index.types.js';

export interface CanonicalPin {
  contestedKey: string;
  canonicalArtifactKey: string;
  pinnedAt: string;
  pinnedBy: string;
  reason: string | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function stageIndexSearchText(stageIndex: StageIndex): string {
  const parts: string[] = [stageIndex.jobId];
  for (const wu of stageIndex.workUnits) {
    parts.push(
      wu.unitKey,
      ...wu.rawFiles,
      ...wu.touchedSlSources.flatMap((source) => [
        source.connectionId,
        source.sourceName,
        `${source.connectionId}:${source.sourceName}`,
      ]),
    );
    for (const action of wu.actions) {
      parts.push(
        action.target,
        action.type,
        action.key,
        action.detail,
        action.targetConnectionId ?? stageIndex.connectionId,
      );
    }
  }
  return normalize(parts.join('\n'));
}

export function selectRelevantCanonicalPins(stageIndex: StageIndex, pins: CanonicalPin[]): CanonicalPin[] {
  if (pins.length === 0) {
    return [];
  }
  const haystack = stageIndexSearchText(stageIndex);
  return pins.filter((pin) => {
    const contestedKey = normalize(pin.contestedKey);
    const canonicalArtifactKey = normalize(pin.canonicalArtifactKey);
    return haystack.includes(contestedKey) || haystack.includes(canonicalArtifactKey);
  });
}

export function buildCanonicalPinsPromptBlock(pins: CanonicalPin[]): string {
  if (pins.length === 0) {
    return '';
  }
  const lines = ['<canonical_pins>'];
  for (const pin of pins) {
    lines.push(`- contestedKey: ${pin.contestedKey}`);
    lines.push(`  canonicalArtifactKey: ${pin.canonicalArtifactKey}`);
    if (pin.reason) {
      lines.push(`  reason: ${pin.reason}`);
    }
  }
  lines.push('</canonical_pins>');
  return lines.join('\n');
}
