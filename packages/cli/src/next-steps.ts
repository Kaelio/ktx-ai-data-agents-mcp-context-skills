/** @internal */
export const KTX_CONTEXT_BUILD_COMMANDS = [
  {
    command: 'ktx ingest',
    description: 'Build or refresh agent-ready context from all configured connections',
  },
  {
    command: 'ktx status',
    description: 'Check setup and context readiness',
  },
] as const;

export const KTX_NEXT_STEP_DIRECT_COMMANDS = [
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
] as const;

/** @internal */
export const KTX_NEXT_STEP_COMMANDS = [...KTX_NEXT_STEP_DIRECT_COMMANDS] as const;

const KTX_NEXT_STEP_COMMAND_WIDTH = Math.max(
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
    `${indent}ktx context is ready for agents. Open your coding agent from the ktx project directory and ask a data question.`,
    `${indent}Verify with:`,
    ...commandLines(KTX_NEXT_STEP_DIRECT_COMMANDS, indent),
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
      `${indent}Setup is complete. The only step left is to build context for your agents.`,
      ...commandLines(KTX_CONTEXT_BUILD_COMMANDS, indent),
    ];
  }

  if (!state.agentIntegrationReady) {
    return [
      `${indent}ktx context is built. Install agent rules when you want your coding agent to use it.`,
      `${indent}$ ${'ktx setup --agents'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Install CLI-based agent rules`,
      `${indent}$ ${'ktx status'.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  Check setup and context readiness`,
    ];
  }

  return formatNextStepLines(indent);
}
