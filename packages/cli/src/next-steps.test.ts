import { describe, expect, it } from 'vitest';
import {
  KTX_CONTEXT_BUILD_COMMANDS,
  KTX_NEXT_STEP_COMMANDS,
  formatNextStepLines,
  formatSetupNextStepLines,
} from './next-steps.js';

const command = (...parts: string[]) => parts.join(' ');

describe('KTX demo next steps', () => {
  it('uses supported context-build commands before agent usage', () => {
    expect(KTX_CONTEXT_BUILD_COMMANDS).toEqual([
      {
        command: 'ktx setup',
        description: 'Build or resume agent-ready context from configured sources',
      },
      {
        command: 'ktx status',
        description: 'Check setup and context readiness',
      },
    ]);
  });

  it('uses supported final public commands', () => {
    expect(KTX_NEXT_STEP_COMMANDS).toEqual([
      {
        command: 'ktx agent context --json',
        description: 'Verify the project context your agent can read',
      },
      {
        command: 'ktx agent tools --json',
        description: 'List direct CLI tools available to agents',
      },
      {
        command: 'ktx sl list',
        description: 'Inspect generated semantic-layer sources',
      },
      {
        command: 'ktx wiki list',
        description: 'Inspect generated wiki pages',
      },
    ]);
  });

  it('uses only the direct CLI route for agent verification', () => {
    const commands = KTX_NEXT_STEP_COMMANDS.map((step) => step.command);

    expect(commands).toContain('ktx agent context --json');
    expect(commands).toContain('ktx agent tools --json');
    expect(commands).not.toContain('ktx serve --mcp stdio --user-id local');
  });

  it('explains what the next-step commands are for', () => {
    const rendered = formatNextStepLines().join('\n');

    expect(rendered).toContain('KTX context is ready for agents.');
    expect(rendered).toContain('ask a data question');
    expect(rendered).toContain('Verify with:');
    expect(rendered).not.toContain('Preferred route');
    expect(rendered).not.toContain('Optional MCP:');
  });

  it('does not advertise removed Commander migration commands', () => {
    const rendered = formatNextStepLines().join('\n');

    expect(rendered).toContain('ktx agent tools --json');
    expect(rendered).toContain('ktx agent context --json');
    expect(rendered).toContain('ktx sl list');
    expect(rendered).toContain('ktx wiki list');

    for (const removed of [
      command('ktx', 'ask'),
      command('ktx', 'mcp'),
      command('ktx', 'connect'),
      command('ktx', 'knowledge'),
      command('dev', 'model'),
      command('dev', 'knowledge'),
      command('ktx', 'ingest', 'run'),
      command('ktx', 'ingest', 'replay'),
      command('ktx', 'serve', '--mcp', 'stdio', '--user-id', 'local'),
    ]) {
      expect(rendered).not.toContain(removed);
    }
  });

  it('keeps setup next steps focused on building context when the build is not ready', () => {
    const rendered = formatSetupNextStepLines({
      setupReady: true,
      hasContextTargets: true,
      contextReady: false,
      agentIntegrationReady: true,
    }).join('\n');

    expect(rendered).toContain('Build KTX context next.');
    expect(rendered).toContain('primary-source scans and context-source ingests');
    expect(rendered).toContain('ktx setup');
    expect(rendered).toContain('ktx status');
    expect(rendered).not.toContain('ktx agent context --json');
    expect(rendered).not.toContain('ktx serve --mcp');
  });

  it('shows agent commands only after setup and context build are ready', () => {
    const rendered = formatSetupNextStepLines({
      setupReady: true,
      hasContextTargets: true,
      contextReady: true,
      agentIntegrationReady: true,
    }).join('\n');

    expect(rendered).toContain('KTX context is ready for agents.');
    expect(rendered).toContain('ktx agent context --json');
    expect(rendered).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(rendered).not.toContain('Build KTX context next.');
  });
});
