export interface KtxColumnEmbeddingForeignKeys {
  outgoing: Array<{ toTable: string; toColumn: string }>;
  incoming: Array<{ fromTable: string; fromColumn: string }>;
}

export interface KtxColumnEmbeddingTextInput {
  tableName: string;
  columnName: string;
  columnType: string;
  resolvedDescription: string | null;
  sampleValues?: readonly string[] | null;
  resolvedTableDescription?: string | null;
  foreignKeys?: KtxColumnEmbeddingForeignKeys | null;
  maxSampleValues?: number;
}

export function buildKtxColumnEmbeddingText(input: KtxColumnEmbeddingTextInput): string {
  const parts: string[] = [];

  parts.push(`${input.tableName}.${input.columnName} (${input.columnType})`);

  if (input.resolvedTableDescription) {
    parts.push(`Table: ${input.resolvedTableDescription}`);
  }

  if (input.resolvedDescription) {
    parts.push(input.resolvedDescription);
  }

  if (input.foreignKeys) {
    for (const fk of input.foreignKeys.outgoing) {
      parts.push(`FK -> ${fk.toTable}.${fk.toColumn}`);
    }
    for (const fk of input.foreignKeys.incoming) {
      parts.push(`FK <- ${fk.fromTable}.${fk.fromColumn}`);
    }
  }

  if (input.sampleValues && input.sampleValues.length > 0) {
    const maxSampleValues = input.maxSampleValues ?? 20;
    parts.push(`Values: ${input.sampleValues.slice(0, maxSampleValues).join(', ')}`);
  }

  return parts.join('. ');
}
