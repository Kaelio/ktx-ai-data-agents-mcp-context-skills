import semver from 'semver';

export type UpdateChannel = 'latest' | 'next';

export type UpdateDecision =
  | { status: 'skip' }
  | { status: 'upToDate'; channel: UpdateChannel; target: string }
  | { status: 'available'; channel: UpdateChannel; target: string };

/** @internal */
export function inferUpdateChannel(installed: string): UpdateChannel | null {
  const parsed = semver.parse(installed);
  if (!parsed || installed === '0.0.0') {
    return null;
  }

  const [prereleaseId] = parsed.prerelease;
  if (prereleaseId === undefined) {
    return 'latest';
  }
  if (prereleaseId === 'rc') {
    return 'next';
  }
  return null;
}

export function decideUpdate(installed: string, distTags: Record<string, string>): UpdateDecision {
  const channel = inferUpdateChannel(installed);
  if (!channel || !semver.valid(installed)) {
    return { status: 'skip' };
  }

  const target = distTags[channel];
  if (!target || !semver.valid(target)) {
    return { status: 'skip' };
  }

  if (semver.gt(target, installed)) {
    return { status: 'available', channel, target };
  }

  return { status: 'upToDate', channel, target };
}
