import { describe, expect, it } from 'vitest';
import { withMenuOptionSpacing, withMultiselectNavigation, withTextInputNavigation } from '../src/prompt-navigation.js';

describe('prompt navigation helpers', () => {
  it('leaves compact single-line menu prompts unchanged', () => {
    expect(withMenuOptionSpacing('What do you want to do?')).toBe('What do you want to do?');
  });

  it('adds a blank separator between multiline menu copy and the option list', () => {
    expect(withMenuOptionSpacing('Which embedding option should ktx use?\n\nktx uses embeddings for search.')).toBe(
      'Which embedding option should ktx use?\n\nktx uses embeddings for search.\n',
    );
  });

  it('does not duplicate an existing option-list separator', () => {
    expect(withMenuOptionSpacing('Question\n\nContext\n')).toBe('Question\n\nContext\n');
  });

  it('keeps multiselect navigation copy multiline so menu renderers can separate it from options', () => {
    expect(withMultiselectNavigation('Which sources?')).toBe(
      'Which sources?\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
    );
  });

  it('adds a blank separator between text input helper copy and the editable value', () => {
    expect(
      withTextInputNavigation(
        'Name this PostgreSQL connection\nktx will use this short name in commands and config. You can rename it now.',
      ),
    ).toBe(
      'Name this PostgreSQL connection\n│\n│  ktx will use this short name in commands and config. You can rename it now.\n│  Press Escape to go back.\n│',
    );
  });

  it('adds a blank separator before compact text input values', () => {
    expect(withTextInputNavigation('Project folder path')).toBe('Project folder path\n│  Press Escape to go back.\n│');
  });

  it('normalizes already hinted text input prompts without duplicating the hint', () => {
    expect(
      withTextInputNavigation(
        'Name this PostgreSQL connection\nktx will use this short name in commands and config. You can rename it now.\nPress Escape to go back.',
      ),
    ).toBe(
      'Name this PostgreSQL connection\n│\n│  ktx will use this short name in commands and config. You can rename it now.\n│  Press Escape to go back.\n│',
    );
  });

  it('is idempotent when text input navigation is applied twice', () => {
    const once = withTextInputNavigation('Project folder path');
    expect(withTextInputNavigation(once)).toBe(once);
  });

  it('is idempotent when text input navigation with body is applied twice', () => {
    const once = withTextInputNavigation(
      'Name this PostgreSQL connection\nktx will use this short name in commands and config.',
    );
    expect(withTextInputNavigation(once)).toBe(once);
  });
});
