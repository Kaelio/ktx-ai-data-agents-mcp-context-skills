import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const promptsSource = join(packageRoot, 'src', 'prompts');
const promptsTarget = join(packageRoot, 'dist', 'prompts');
const skillsSource = join(packageRoot, 'src', 'skills');
const skillsTarget = join(packageRoot, 'dist', 'skills');

await rm(promptsTarget, { recursive: true, force: true });
await rm(skillsTarget, { recursive: true, force: true });
await mkdir(dirname(promptsTarget), { recursive: true });
await mkdir(dirname(skillsTarget), { recursive: true });
await cp(promptsSource, promptsTarget, { recursive: true });
await cp(skillsSource, skillsTarget, { recursive: true });
