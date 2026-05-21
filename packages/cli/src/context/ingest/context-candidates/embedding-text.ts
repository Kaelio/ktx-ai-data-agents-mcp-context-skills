interface ContextCandidateEmbeddingTextInput {
  topic: string;
  assertion: string;
}

export function buildContextCandidateEmbeddingText(input: ContextCandidateEmbeddingTextInput): string {
  return `${input.topic} - ${input.assertion}`;
}
