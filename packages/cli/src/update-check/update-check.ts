import type { KtxCliIo } from '../cli-runtime.js';
import { cyan, dim, type CliStyleEnv } from '../clack.js';
import { resolveOutputMode } from '../io/mode.js';
import { type UpdateCheckCache, readUpdateCheckCache, writeUpdateCheckCache } from './cache.js';
import { decideUpdate, inferUpdateChannel, type UpdateChannel } from './channel.js';
import { fetchDistTags as defaultFetchDistTags } from './registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** @internal */
export interface UpdateCheckEnv extends NodeJS.ProcessEnv, CliStyleEnv {
  CI?: string;
  DO_NOT_TRACK?: string;
  KTX_NO_UPDATE_CHECK?: string;
  KTX_OUTPUT?: string;
  NO_UPDATE_NOTIFIER?: string;
}

/** @internal */
export interface UpdateCheckCommandOptions {
  format?: unknown;
  json?: unknown;
  output?: unknown;
}

export interface PrepareUpdateCheckNoticeOptions {
  commandOptions?: UpdateCheckCommandOptions;
  env?: UpdateCheckEnv;
  fetchDistTags?: () => Promise<Record<string, string>>;
  homeDir?: string;
  installedVersion: string;
  io: KtxCliIo;
  now?: () => Date;
}

export interface PreparedUpdateCheckNotice {
  notice: string | null;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function commandRequestsJson(options: UpdateCheckCommandOptions | undefined): boolean {
  return options?.json === true || options?.output === 'json' || options?.format === 'json';
}

/** @internal */
export function shouldSuppressUpdateCheck(args: {
  commandOptions?: UpdateCheckCommandOptions;
  env?: UpdateCheckEnv;
  io: KtxCliIo;
}): boolean {
  const env = args.env ?? process.env;
  if (truthy(env.KTX_NO_UPDATE_CHECK) || truthy(env.NO_UPDATE_NOTIFIER) || truthy(env.DO_NOT_TRACK)) {
    return true;
  }

  if (commandRequestsJson(args.commandOptions) || truthy(env.CI) || args.io.stdout.isTTY !== true) {
    return true;
  }

  try {
    const mode = resolveOutputMode({
      json: false,
      io: args.io,
      env,
    });
    return mode !== 'pretty';
  } catch {
    return true;
  }
}

/** @internal */
export function renderUpdateNotice(args: {
  channel: UpdateChannel;
  env?: CliStyleEnv;
  installedVersion: string;
  targetVersion: string;
}): string {
  const command = args.channel === 'next' ? 'npm i -g @kaelio/ktx@next' : 'npm i -g @kaelio/ktx';
  return `${cyan('↑', args.env)} Update available: ktx ${args.installedVersion} → ${args.targetVersion}\n  ${dim(command, args.env)}\n`;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function elapsedAtLeast(value: string | undefined, now: Date, intervalMs: number): boolean {
  const previous = timestampMs(value);
  if (previous === null) {
    return true;
  }
  return now.getTime() - previous >= intervalMs;
}

function shouldRefreshCache(cache: UpdateCheckCache | null, installedVersion: string, now: Date): boolean {
  if (!cache || cache.installedVersion !== installedVersion) {
    return true;
  }
  return elapsedAtLeast(cache.checkedAt, now, DAY_MS);
}

async function refreshUpdateCache(args: {
  cache: UpdateCheckCache | null;
  fetchDistTags: () => Promise<Record<string, string>>;
  homeDir?: string;
  installedVersion: string;
  now: Date;
}): Promise<void> {
  const distTags = await args.fetchDistTags();
  const decision = decideUpdate(args.installedVersion, distTags);
  if (decision.status === 'skip') {
    return;
  }

  await writeUpdateCheckCache(
    {
      checkedAt: args.now.toISOString(),
      channel: decision.channel,
      installedVersion: args.installedVersion,
      latestForChannel: decision.target,
      ...(args.cache?.installedVersion === args.installedVersion && args.cache.channel === decision.channel
        ? { lastNoticeAt: args.cache.lastNoticeAt }
        : {}),
    },
    { homeDir: args.homeDir },
  );
}

export async function prepareUpdateCheckNotice(
  options: PrepareUpdateCheckNoticeOptions,
): Promise<PreparedUpdateCheckNotice> {
  const env = options.env ?? process.env;
  const now = (options.now ?? (() => new Date()))();
  const fetchDistTags = options.fetchDistTags ?? defaultFetchDistTags;

  if (
    shouldSuppressUpdateCheck({
      commandOptions: options.commandOptions,
      env,
      io: options.io,
    })
  ) {
    return { notice: null };
  }

  if (!inferUpdateChannel(options.installedVersion)) {
    return { notice: null };
  }

  let cache = await readUpdateCheckCache({ homeDir: options.homeDir });
  let notice: string | null = null;

  if (cache?.installedVersion === options.installedVersion) {
    const decision = decideUpdate(options.installedVersion, {
      [cache.channel]: cache.latestForChannel,
    });
    if (decision.status === 'available' && elapsedAtLeast(cache.lastNoticeAt, now, DAY_MS)) {
      notice = renderUpdateNotice({
        channel: decision.channel,
        env,
        installedVersion: options.installedVersion,
        targetVersion: decision.target,
      });
      cache = { ...cache, lastNoticeAt: now.toISOString() };
      await writeUpdateCheckCache(cache, { homeDir: options.homeDir });
    }
  }

  if (shouldRefreshCache(cache, options.installedVersion, now)) {
    void refreshUpdateCache({
      cache,
      fetchDistTags,
      homeDir: options.homeDir,
      installedVersion: options.installedVersion,
      now,
    }).catch(() => {});
  }

  return { notice };
}
