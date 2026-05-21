import {
  redactKtxSensitiveMetadata,
  redactKtxSensitiveText,
  redactKtxSensitiveValue,
} from '../core/redaction.js';
import type { KtxCredentialEnvelope, KtxScanReport, KtxScanWarning } from './types.js';

/** @internal */
export function redactKtxCredentialValue(key: string, value: unknown): unknown {
  return redactKtxSensitiveValue(key, value);
}

/** @internal */
export function redactKtxScanMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactKtxSensitiveMetadata(metadata);
}

/** @internal */
export function redactKtxCredentialEnvelope(envelope: KtxCredentialEnvelope): KtxCredentialEnvelope {
  if (envelope.kind !== 'resolved') {
    return envelope;
  }
  return {
    kind: 'resolved',
    source: envelope.source,
    redacted: true,
    values: redactKtxScanMetadata(envelope.values),
  };
}

/** @internal */
export function redactKtxScanWarning(warning: KtxScanWarning): KtxScanWarning {
  if (!warning.metadata) {
    return {
      ...warning,
      message: redactKtxSensitiveText(warning.message),
    };
  }
  return {
    ...warning,
    message: redactKtxSensitiveText(warning.message),
    metadata: redactKtxScanMetadata(warning.metadata),
  };
}

export function redactKtxScanReport(report: KtxScanReport): KtxScanReport {
  return {
    ...report,
    warnings: report.warnings.map((warning) => redactKtxScanWarning(warning)),
  };
}
