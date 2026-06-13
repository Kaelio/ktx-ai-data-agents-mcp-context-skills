import { PassThrough } from 'node:stream';
import { multiselect } from '@clack/prompts';
import { describe, expect, it } from 'vitest';
// Importing the adapter module registers the tab→space alias on clack settings.
import '../src/setup-prompts.js';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode: (value: boolean) => void };
type FakeOutput = PassThrough & { isTTY: boolean; columns: number; rows: number };

function fakeTty(): { input: FakeInput; output: FakeOutput } {
  const input = new PassThrough() as FakeInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough() as FakeOutput;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();
  return { input, output };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Tab selection in a flat multiselect', () => {
  it('toggles the focused option, proving the adapter alias drives a real clack multiselect', async () => {
    const { input, output } = fakeTty();
    const result = multiselect({
      message: 'Pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      input,
      output,
    });

    await tick();
    input.emit('keypress', '\t', { name: 'tab' });
    await tick();
    input.emit('keypress', '', { name: 'return' });

    expect(await result).toEqual(['a']);
  });
});
