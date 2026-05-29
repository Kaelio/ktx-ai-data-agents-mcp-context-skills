// Static shell completion scripts emitted by `ktx completion <shell>`.
//
// Both scripts gather the words on the current command line (excluding the
// leading `ktx`), append the partial word under the cursor, and delegate to the
// hidden `ktx __complete` command, which prints newline-separated candidates.
// All command/flag/entity knowledge lives in `ktx __complete` so these scripts
// never have to encode the command tree.
//
// Lines are single-quoted JS strings so the shell `${...}` expansions are
// emitted verbatim (a template literal would try to interpolate them).

const ZSH_SCRIPT = [
  '#compdef ktx',
  '_ktx() {',
  '  local -a candidates',
  '  local out',
  '  out="$(ktx __complete -- "${words[@]:1:$((CURRENT-1))}" 2>/dev/null)" || return 0',
  '  candidates=("${(@f)out}")',
  '  compadd -- $candidates',
  '}',
  'compdef _ktx ktx',
  '',
].join('\n');

const BASH_SCRIPT = [
  '_ktx() {',
  '  local cur out',
  '  cur="${COMP_WORDS[COMP_CWORD]}"',
  '  out="$(ktx __complete -- "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)" || { COMPREPLY=(); return 0; }',
  "  local IFS=$'\\n'",
  '  COMPREPLY=($(compgen -W "${out}" -- "$cur"))',
  '}',
  'complete -F _ktx ktx',
  '',
].join('\n');

export function completionScript(shell: 'zsh' | 'bash'): string {
  return shell === 'zsh' ? ZSH_SCRIPT : BASH_SCRIPT;
}
