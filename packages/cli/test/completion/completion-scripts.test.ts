import { describe, expect, it } from 'vitest';
import { completionScript } from '../../src/completion/completion-scripts.js';

describe('completionScript', () => {
  it('emits a zsh script that registers _ktx and delegates to ktx __complete', () => {
    const script = completionScript('zsh');
    expect(script).toContain('#compdef ktx');
    expect(script).toContain('compdef _ktx ktx');
    expect(script).toContain('ktx __complete --');
    expect(script).toContain('compadd -- $candidates');
  });

  it('emits a bash script that registers _ktx and preserves newline-split candidates', () => {
    const script = completionScript('bash');
    expect(script).toContain('complete -F _ktx ktx');
    expect(script).toContain('ktx __complete --');
    expect(script).toContain("local IFS=$'\\n'");
    expect(script).toContain('COMPREPLY=($(compgen -W "${out}" -- "$cur"))');
  });
});
