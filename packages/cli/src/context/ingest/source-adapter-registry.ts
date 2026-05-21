import type { SourceAdapter } from './types.js';

export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.source)) {
      throw new Error(`source adapter already registered for '${adapter.source}'`);
    }
    this.adapters.set(adapter.source, adapter);
  }

  get(sourceKey: string): SourceAdapter {
    const adapter = this.adapters.get(sourceKey);
    if (!adapter) {
      const known = [...this.adapters.keys()].join(', ') || '(none)';
      throw new Error(`no source adapter registered for '${sourceKey}'. Known: ${known}`);
    }
    return adapter;
  }

  has(sourceKey: string): boolean {
    return this.adapters.has(sourceKey);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
