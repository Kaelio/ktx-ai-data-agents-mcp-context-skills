import { describe, expect, it } from 'vitest';
import {
  KTX_CONTEXT_BUILD_COMMANDS,
  KTX_NEXT_STEP_COMMANDS,
  formatNextStepLines,
  formatSetupNextStepLines,
} from '../src/next-steps.js';

describe('KTX demo next steps', () => {
  it('uses supported context-build commands before agent usage', () => {
    expect(KTX_CONTEXT_BUILD_COMMANDS).toEqual([
      {
        command: 'ktx ingest',
        description: 'Build or refresh agent-ready context from all configured connections',
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
        command: 'ktx status --json',
        description: 'Verify project setup and context readiness',
      },
      {
        command: 'ktx sl',
        description: 'Inspect generated semantic-layer sources',
      },
      {
        command: 'ktx wiki',
        description: 'Inspect generated wiki pages',
      },
    ]);
  });

  it('uses only the direct CLI route for agent verification', () => {
    const commands = KTX_NEXT_STEP_COMMANDS.map((step) => step.command);

    expect(commands).not.toContain('ktx agent context --json');
    expect(commands).toContain('ktx status --json');
    expect(commands).not.toContain('ktx serve --mcp stdio --user-id local');
  });

  it('explains what the next-step commands are for', () => {
    const rendered = formatNextStepLines().join('\n');

    expect(rendered).toContain('KTX context is ready for agents.');
    expect(rendered).toContain('KTX project directory');
    expect(rendered).toContain('ask a data question');
    expect(rendered).toContain('Verify with:');
    expect(rendered).not.toContain('this directory');
    expect(rendered).not.toContain('Preferred route');
    expect(rendered).not.toContain('Optional MCP:');
  });

  it('keeps setup next steps focused on building context when the build is not ready', () => {
    const rendered = formatSetupNextStepLines({
      setupReady: true,
      hasContextTargets: true,
      contextReady: false,
      agentIntegrationReady: true,
    }).join('\n');

    expect(rendered).toContain('Build KTX context next.');
    expect(rendered).toContain('Run ingest to build database schema context before context-source ingest.');
    expect(rendered).toContain('ktx ingest');
    expect(rendered).not.toContain('resume');
    expect(rendered).not.toContain('scan');
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
    expect(rendered).toContain('ktx status --json');
    expect(rendered).not.toContain('ktx agent');
    expect(rendered).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(rendered).not.toContain('Build KTX context next.');
  });
});
