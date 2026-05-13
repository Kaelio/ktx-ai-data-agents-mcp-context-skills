const MULTISELECT_MENU_NAVIGATION_HINT =
  'Use Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.';
const TEXT_INPUT_NAVIGATION_HINT = 'Press Escape to go back.';

function removeTrailingBlankLines(message: string): string {
  return message.replace(/\n+$/, '');
}

function prefixContinuationLines(message: string): string {
  const lines = message.split('\n');
  if (lines.length <= 1) return message;
  const [title, ...body] = lines;
  let trailingEmptyCount = 0;
  while (trailingEmptyCount < body.length && body[body.length - 1 - trailingEmptyCount] === '') {
    trailingEmptyCount++;
  }
  const contentBody = trailingEmptyCount > 0 ? body.slice(0, -trailingEmptyCount) : body;
  const trailingBody = trailingEmptyCount > 0 ? body.slice(-trailingEmptyCount) : [];
  return [
    title,
    ...contentBody.map((line) => {
      const stripped = line.replace(/^│\s*/, '');
      return stripped === '' ? '│' : `│  ${stripped}`;
    }),
    ...trailingBody,
  ].join('\n');
}

function withTextInputBodySpacing(message: string): string {
  const normalized = removeTrailingBlankLines(message);
  if (!normalized.includes('\n')) {
    return normalized;
  }
  const [title, ...bodyLines] = normalized.split('\n');
  if (bodyLines[0] === '') {
    return normalized;
  }
  return `${title}\n\n${bodyLines.join('\n')}`;
}

export function withMenuOptionSpacing(message: string): string {
  if (!message.includes('\n') || message.endsWith('\n')) {
    return message;
  }
  return `${message}\n`;
}

export function withMenuOptionsSpacing<T extends { message: string }>(options: T): T {
  return { ...options, message: withMenuOptionSpacing(options.message) };
}

export function withMultiselectNavigation(message: string): string {
  if (message.includes(MULTISELECT_MENU_NAVIGATION_HINT)) {
    return message;
  }
  return `${message}\n${MULTISELECT_MENU_NAVIGATION_HINT}`;
}

export function withTextInputNavigation(message: string): string {
  const messageWithoutHint = removeTrailingBlankLines(message)
    .split('\n')
    .filter((line) => !line.includes(TEXT_INPUT_NAVIGATION_HINT))
    .map((line) => line.replace(/^│\s*/, ''))
    .join('\n');
  const full = `${withTextInputBodySpacing(messageWithoutHint)}\n${TEXT_INPUT_NAVIGATION_HINT}`;
  return `${prefixContinuationLines(full)}\n│`;
}
