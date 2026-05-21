/** @internal */
export const REDACTED_KTX_CREDENTIAL_VALUE = '<redacted>';

const SENSITIVE_FIELD_NAME = /(password|secret|token|api[_-]?key|private[_-]?key|passphrase|credential|authorization|url)/i;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_NAME.test(key);
}

export function redactKtxSensitiveValue(key: string, value: unknown): unknown {
  if (isSensitiveField(key)) {
    return REDACTED_KTX_CREDENTIAL_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactKtxSensitiveValue(key, item));
  }
  if (isRecord(value)) {
    return redactKtxSensitiveMetadata(value);
  }
  return value;
}

export function redactKtxSensitiveMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      redacted[key] = value.map((item) =>
        isRecord(item) ? redactKtxSensitiveMetadata(item) : redactKtxSensitiveValue(key, item),
      );
      continue;
    }
    if (isRecord(value)) {
      redacted[key] = redactKtxSensitiveValue(key, value);
      continue;
    }
    redacted[key] = redactKtxSensitiveValue(key, value);
  }
  return redacted;
}

export function redactKtxSensitiveText(value: string): string {
  return value.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_KTX_CREDENTIAL_VALUE}$3`);
}
