const enabled = process.env.KTX_PROFILE_STARTUP === '1' || process.env.KTX_PROFILE_STARTUP === 'true';
const processStart = performance.now() - process.uptime() * 1000;

interface StartupProfileEvent {
  label: string;
  at: number;
  duration?: number;
}

const events: StartupProfileEvent[] = [];

function now(): number {
  return performance.now() - processStart;
}

export function profileMark(label: string): void {
  if (!enabled) {
    return;
  }
  events.push({ label, at: now() });
}

export async function profileSpan<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!enabled) {
    return await run();
  }
  const start = now();
  try {
    return await run();
  } finally {
    events.push({ label, at: start, duration: now() - start });
  }
}

export function installStartupProfileReporter(): void {
  if (!enabled) {
    return;
  }

  process.once('beforeExit', () => {
    const total = now();
    process.stderr.write('\nktx startup profile\n');
    for (const event of events) {
      const elapsed = event.at.toFixed(1).padStart(7);
      if (event.duration === undefined) {
        process.stderr.write(`${elapsed} ms  ${event.label}\n`);
      } else {
        const duration = event.duration.toFixed(1).padStart(7);
        process.stderr.write(`${elapsed} ms  ${duration} ms  ${event.label}\n`);
      }
    }
    process.stderr.write(`${total.toFixed(1).padStart(7)} ms  total\n`);
  });
}
