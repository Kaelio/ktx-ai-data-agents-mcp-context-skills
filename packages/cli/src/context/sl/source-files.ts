import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { KtxFileStorePort } from '../../context/core/file-store.js';

// Semantic-layer source identity lives in the file's `name:` field, which mirrors
// the warehouse identifier verbatim (Snowflake's uppercase `SIGNED_UP`, `EVENT$LOG`).
// The filename is a derived label and never participates in identity: reads resolve
// a source by scanning the connection directory and matching `name:`, and writes
// reuse the resolved file's path, so files can be freely renamed by humans without
// changing which source they define.

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

export function assertSafeConnectionId(connectionId: string): string {
  if (!isSafeConnectionId(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  return assertSafePathToken('connection id', connectionId);
}

export function isSafeConnectionId(connectionId: string | undefined): connectionId is string {
  return typeof connectionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId);
}

export function sourceNameFromPath(path: string): string {
  return (
    path
      .split('/')
      .at(-1)
      ?.replace(/\.ya?ml$/, '') ?? path
  );
}

// Windows refuses these basenames regardless of extension — a genuinely universal
// filesystem invariant, so the static list is acceptable.
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

const SAFE_FILE_BASENAME = /^[a-z0-9][a-z0-9_]{0,63}$/;

/**
 * Derive the filename for a semantic-layer source. Total over all possible
 * source names — never throws.
 *
 * Names that are already safe lowercase snake_case become `<name>.yaml`;
 * anything else becomes `<slug>-<8 hex of sha256(name)>.yaml`. The two ranges
 * are disjoint and the mapping is injective: safe filenames contain no `-`,
 * hashed filenames always end in `-<8 hex>`, and slugs are lowercased so names
 * differing only by case get distinct hashes instead of colliding paths on
 * case-insensitive filesystems (macOS APFS, Windows).
 *
 * @internal
 */
export function slSourceFileName(sourceName: string): string {
  if (SAFE_FILE_BASENAME.test(sourceName) && !WINDOWS_RESERVED_BASENAME.test(sourceName)) {
    return `${sourceName}.yaml`;
  }
  const slug = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const hash = createHash('sha256').update(sourceName, 'utf-8').digest('hex').slice(0, 8);
  return `${slug || 'src'}-${hash}.yaml`;
}

export function slSourceFilePath(connectionId: string, sourceName: string): string {
  return `semantic-layer/${assertSafeConnectionId(connectionId)}/${slSourceFileName(sourceName)}`;
}

export interface SlSourceFile {
  path: string;
  content: string;
}

// Same keying as `loadLocalSlSourceRecords`: the in-file `name:` is the identity;
// the filename is only a fallback for unparseable or nameless files (a broken file
// is therefore addressed by its filename-derived name until it is repaired).
export function slSourceNameForFile(path: string, content: string): string {
  try {
    const parsed = YAML.parse(content) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }
  } catch {
    // Unparseable — fall through to the filename.
  }
  return sourceNameFromPath(path);
}

/**
 * Find the standalone/overlay file that defines `sourceName` for a connection.
 * Returns null when no file declares the name (the source may still exist as a
 * manifest entry under `_schema/`). Throws when more than one file declares the
 * same name — that breaks the one-file-per-name invariant and must be repaired
 * by hand rather than silently picking one.
 */
export async function resolveSlSourceFile(
  fileStore: Pick<KtxFileStorePort, 'listFiles' | 'readFile'>,
  connectionId: string,
  sourceName: string,
): Promise<SlSourceFile | null> {
  const dir = `semantic-layer/${assertSafeConnectionId(connectionId)}`;
  const schemaDir = `${dir}/_schema`;
  const listed = await fileStore.listFiles(dir);
  const paths = listed.files
    .filter((file) => (file.endsWith('.yaml') || file.endsWith('.yml')) && !file.startsWith(`${schemaDir}/`))
    .sort();

  const matches: SlSourceFile[] = [];
  for (const path of paths) {
    const raw = await fileStore.readFile(path);
    if (slSourceNameForFile(path, raw.content) === sourceName) {
      matches.push({ path, content: raw.content });
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple semantic-layer files declare source "${sourceName}": ${matches.map((match) => match.path).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}
