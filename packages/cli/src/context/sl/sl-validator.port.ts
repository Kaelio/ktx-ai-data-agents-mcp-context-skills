interface SlValidationResult {
  errors: string[];
  warnings: string[];
}

export interface SlValidatorPort<TDeps = unknown> {
  validateSingleSource(deps: TDeps, connectionId: string, sourceName: string): Promise<SlValidationResult>;
}
