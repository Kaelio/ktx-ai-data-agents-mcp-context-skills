import { styleText } from 'node:util';
import { PasswordPrompt, type PasswordOptions } from '@clack/core';
import { S_BAR, S_BAR_END, S_PASSWORD_MASK, settings, symbol } from '@clack/prompts';

// How many trailing characters of a pasted secret to leave visible so the user
// can confirm what landed (e.g. `••••••a1b2`). Kept small on purpose.
const REVEAL_TAIL_COUNT = 4;

/**
 * Mask every character of `userInput` except the last `tail`, but only reveal the
 * tail once the secret is long enough that the hidden portion still dominates
 * (`length > tail * 2`). Short secrets stay fully masked so we never expose most
 * of a small value. The returned string keeps the same code-unit length as the
 * input so clack's cursor slicing in `userInputWithCursor` stays aligned.
 *
 * @internal
 */
export function maskRevealingTail(userInput: string, maskChar: string, tail: number): string {
  const revealLength = userInput.length > tail * 2 ? tail : 0;
  const hiddenLength = userInput.length - revealLength;
  return maskChar.repeat(hiddenLength) + userInput.slice(hiddenLength);
}

class RevealTailPasswordPrompt extends PasswordPrompt {
  readonly #maskChar: string;
  readonly #tail: number;

  constructor(options: PasswordOptions & { tail: number }) {
    super(options);
    this.#maskChar = options.mask ?? S_PASSWORD_MASK;
    this.#tail = options.tail;
  }

  override get masked(): string {
    return maskRevealingTail(this.userInput, this.#maskChar, this.#tail);
  }
}

// Reproduces the @clack/prompts password frame (pinned to the installed version)
// so this prompt is visually identical to every other setup prompt; the only
// behavioral change is the tail-revealing `masked` getter above.
function renderPasswordFrame(prompt: Omit<PasswordPrompt, 'prompt'>, message: string): string {
  const withGuide = settings.withGuide;
  const title = `${withGuide ? `${styleText('gray', S_BAR)}\n` : ''}${symbol(prompt.state)}  ${message}\n`;
  const masked = prompt.masked;
  switch (prompt.state) {
    case 'error': {
      const bar = withGuide ? `${styleText('yellow', S_BAR)}  ` : '';
      const end = withGuide ? `${styleText('yellow', S_BAR_END)}  ` : '';
      return `${title.trim()}\n${bar}${masked}\n${end}${styleText('yellow', prompt.error)}\n`;
    }
    case 'submit': {
      const bar = withGuide ? `${styleText('gray', S_BAR)}  ` : '';
      return `${title}${bar}${masked ? styleText('dim', masked) : ''}`;
    }
    case 'cancel': {
      const bar = withGuide ? `${styleText('gray', S_BAR)}  ` : '';
      const body = masked ? styleText(['strikethrough', 'dim'], masked) : '';
      return `${title}${bar}${body}${masked && withGuide ? `\n${styleText('gray', S_BAR)}` : ''}`;
    }
    default: {
      const bar = withGuide ? `${styleText('cyan', S_BAR)}  ` : '';
      const end = withGuide ? styleText('cyan', S_BAR_END) : '';
      return `${title}${bar}${prompt.userInputWithCursor}\n${end}\n`;
    }
  }
}

export interface RevealPasswordOptions {
  message: string;
  mask?: string;
  tail?: number;
  validate?: PasswordOptions['validate'];
  signal?: AbortSignal;
}

/**
 * Drop-in replacement for clack's `password()` that reveals the last few
 * characters of the entered value while typing. Resolves to the raw value or the
 * clack cancel symbol, matching `password()`'s contract.
 */
export function revealPassword(options: RevealPasswordOptions): Promise<string | symbol> {
  const prompt = new RevealTailPasswordPrompt({
    mask: options.mask ?? S_PASSWORD_MASK,
    tail: options.tail ?? REVEAL_TAIL_COUNT,
    validate: options.validate,
    signal: options.signal,
    render() {
      return renderPasswordFrame(this, options.message);
    },
  });
  return prompt.prompt() as Promise<string | symbol>;
}
