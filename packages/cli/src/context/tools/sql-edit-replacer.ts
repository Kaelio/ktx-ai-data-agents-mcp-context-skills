export interface SqlEdit {
  oldText: string;
  newText: string;
  reason?: string;
}

interface SqlEditResult {
  success: boolean;
  sql: string;
  appliedEdits: number;
  errors: string[];
}

type ReplacerResult = { sql: string; note?: string } | { error: string } | null;

function exactReplacer(sql: string, oldText: string, newText: string): ReplacerResult {
  if (oldText.length === 0) {
    return null;
  }

  let count = 0;
  let idx = -1;
  let searchFrom = 0;

  while (true) {
    const found = sql.indexOf(oldText, searchFrom);
    if (found === -1) {
      break;
    }
    count++;
    idx = found;
    searchFrom = found + 1;
  }

  if (count === 0) {
    return null;
  }
  if (count > 1) {
    return { error: `Found ${count} matches for text, expected 1. Add more surrounding context.` };
  }

  return { sql: sql.slice(0, idx) + newText + sql.slice(idx + oldText.length) };
}

function buildCharacterMap(original: string): number[] {
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    if (/\s/.test(original[i])) {
      if (map.length === 0 || !/\s/.test(original[i - 1])) {
        map.push(i);
      }
    } else {
      map.push(i);
    }
  }
  return map;
}

function whitespaceNormalizedReplacer(sql: string, oldText: string, newText: string): ReplacerResult {
  const normalizedSql = sql.replace(/\s+/g, ' ');
  const normalizedOldText = oldText.replace(/\s+/g, ' ');

  if (normalizedOldText.length === 0) {
    return null;
  }

  let count = 0;
  let matchIdx = -1;
  let searchFrom = 0;

  while (true) {
    const found = normalizedSql.indexOf(normalizedOldText, searchFrom);
    if (found === -1) {
      break;
    }
    count++;
    matchIdx = found;
    searchFrom = found + 1;
  }

  if (count === 0) {
    return null;
  }
  if (count > 1) {
    return null;
  }

  const charMap = buildCharacterMap(sql);

  const originalStart = charMap[matchIdx];
  const normalizedEnd = matchIdx + normalizedOldText.length;

  let originalEnd: number;
  if (normalizedEnd >= charMap.length) {
    originalEnd = sql.length;
  } else {
    originalEnd = charMap[normalizedEnd];
  }

  return { sql: sql.slice(0, originalStart) + newText + sql.slice(originalEnd) };
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

function fuzzyReplacer(sql: string, oldText: string, newText: string): ReplacerResult {
  if (oldText.length === 0) {
    return null;
  }

  const targetLen = oldText.length;
  const minWindow = Math.max(1, Math.floor(targetLen * 0.85));
  const maxWindow = Math.ceil(targetLen * 1.15);

  let bestDistance = Infinity;
  let bestStart = -1;
  let bestEnd = -1;

  for (let windowLen = minWindow; windowLen <= maxWindow; windowLen++) {
    if (windowLen > sql.length) {
      break;
    }

    for (let start = 0; start <= sql.length - windowLen; start++) {
      const candidate = sql.slice(start, start + windowLen);
      const distance = levenshteinDistance(candidate, oldText);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestStart = start;
        bestEnd = start + windowLen;
      }
    }
  }

  if (bestStart === -1) {
    return null;
  }

  const maxLen = Math.max(oldText.length, bestEnd - bestStart);
  const similarity = 1 - bestDistance / maxLen;

  if (similarity < 0.85) {
    return null;
  }

  const matchedText = sql.slice(bestStart, bestEnd);
  return {
    sql: sql.slice(0, bestStart) + newText + sql.slice(bestEnd),
    note: `Fuzzy match used (similarity: ${(similarity * 100).toFixed(1)}%, matched: "${matchedText}")`,
  };
}

interface ApplySqlEditsOptions {
  exactOnly?: boolean;
}

export function applySqlEdits(sql: string, edits: SqlEdit[], options?: ApplySqlEditsOptions): SqlEditResult {
  let currentSql = sql;
  let appliedEdits = 0;
  const errors: string[] = [];

  for (const edit of edits) {
    const replacers = options?.exactOnly
      ? [exactReplacer]
      : [exactReplacer, whitespaceNormalizedReplacer, fuzzyReplacer];
    let applied = false;

    for (const replacer of replacers) {
      const result = replacer(currentSql, edit.oldText, edit.newText);

      if (result === null) {
        continue;
      }

      if ('error' in result) {
        const context = edit.reason ? ` (reason: ${edit.reason})` : '';
        errors.push(`${result.error}${context}`);
        applied = true;
        break;
      }

      currentSql = result.sql;
      appliedEdits++;
      applied = true;
      break;
    }

    if (!applied) {
      const context = edit.reason ? ` (reason: ${edit.reason})` : '';
      errors.push(
        `No match found for edit${context}: "${edit.oldText.slice(0, 80)}${edit.oldText.length > 80 ? '...' : ''}"`,
      );
    }
  }

  return {
    success: errors.length === 0,
    sql: currentSql,
    appliedEdits,
    errors,
  };
}
