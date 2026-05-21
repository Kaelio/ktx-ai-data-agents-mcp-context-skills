export function bucketExecutions(value: number): string {
  if (value < 10) return '<10';
  if (value < 100) return '10-100';
  if (value < 1000) return '100-1k';
  if (value < 5000) return '1k-5k';
  if (value < 50000) return '5k-50k';
  return '>50k';
}

export function bucketDistinctUsers(value: number): string {
  if (value <= 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 10) return '5-10';
  return '>10';
}

export function bucketErrorRate(value: number): string {
  if (value <= 0) return 'none';
  if (value < 0.1) return 'low';
  return 'high';
}

export function bucketP95Runtime(value: number | null): string {
  if (value === null) return 'unknown';
  if (value < 100) return '<100ms';
  if (value < 1000) return '100ms-1s';
  if (value < 10000) return '1s-10s';
  return '>10s';
}

export function bucketRecency(lastSeen: string, now: Date): string {
  const parsed = new Date(lastSeen);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown';
  }
  const ageDays = (now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays <= 7) return 'current';
  if (ageDays <= 45) return 'recent';
  return 'stale';
}

export function bucketFrequency(count: number, total: number): 'high' | 'mid' | 'low' {
  if (total <= 0 || count <= 0) return 'low';
  const ratio = count / total;
  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.1) return 'mid';
  return 'low';
}
