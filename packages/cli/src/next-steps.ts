export const KTX_CONTEXT_BUILD_COMMANDS = [
  {
    command: 'ktx setup context build',
    description: 'Build agent-ready context from configured primary and context sources',
  },
  {
    command: 'ktx status',
    description: 'Check setup and context readiness',
  },
  {
    command: 'ktx setup context status',
    description: 'Check the setup-managed context build state',
  },
] as const;

export const KTX_NEXT_STEP_DIRECT_COMMANDS = [
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
] as const;

export const KTX_NEXT_STEP_MCP_COMMANDS = [
  {
    command: 'ktx serve --mcp stdio --user-id local',
    description: 'Optional MCP server route for clients that require MCP',
  },
] as const;

export const KTX_NEXT_STEP_COMMANDS = [...KTX_NEXT_STEP_DIRECT_COMMANDS, ...KTX_NEXT_STEP_MCP_COMMANDS] as const;

export const KTX_NEXT_STEP_COMMAND_WIDTH = Math.max(
  ...[...KTX_CONTEXT_BUILD_COMMANDS, ...KTX_NEXT_STEP_COMMANDS].map((step) => step.command.length),
);

export interface KtxSetupNextStepState {
  setupReady: boolean;
  hasContextTargets: boolean;
  contextReady: boolean;
  agentIntegrationReady: boolean;
}

function commandLines(commands: ReadonlyArray<{ command: string; description: string }>, indent: string): string[] {
  return commands.map((step) => `${indent}$ ${step.command.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  ${step.description}`);
}

export function formatNextStepLines(indent = '  '): string[] {
  return [
    `${indent}KTX context is ready for agents.`,
    `${indent}Preferred route: CLI + Skills; installed rules call the pinned local CLI directly, so no MCP server is required.`,
    `${indent}Direct CLI checks:`,
    ...commandLines(KTX_NEXT_STEP_DIRECT_COMMANDS, indent),
    `${indent}Optional MCP:`,
    ...commandLines(KTX_NEXT_STEP_MCP_COMMANDS, indent),
  ];
}

export function formatSetupNextStepLines(state: KtxSetupNextStepState, indent = '  '): string[] {
  if (!state.setupReady) {
    return [
      `${indent}Finish setup first.`,
      `${indent}$ ${'ktx setup'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Resume configuration and validation`,
      `${indent}$ ${'ktx status'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Check which setup steps still need attention`,
    ];
  }

  if (!state.hasContextTargets) {
    return [
      `${indent}Connect data, then build context.`,
      `${indent}$ ${'ktx setup'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Add primary or context sources`,
      `${indent}$ ${'ktx status'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Check setup and context readiness`,
    ];
  }

  if (!state.contextReady) {
    return [
      `${indent}Build KTX context next.`,
      `${indent}Preferred route: run the CLI build; it covers primary-source scans and context-source ingests.`,
      ...commandLines(KTX_CONTEXT_BUILD_COMMANDS, indent),
    ];
  }

  if (!state.agentIntegrationReady) {
    return [
      `${indent}KTX context is built. Install agent rules when you want your coding agent to use it.`,
      `${indent}$ ${'ktx setup --agents'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Install CLI-based agent rules`,
      `${indent}$ ${'ktx status'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Check setup and context readiness`,
    ];
  }

  return formatNextStepLines(indent);
}
