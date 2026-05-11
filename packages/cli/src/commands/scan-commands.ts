import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, parsePositiveIntegerOption, resolveCommandProjectDir } from '../cli-program.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxScanArgs } from '../scan.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/scan-commands');

async function runScanArgs(context: KtxCliCommandContext, args: KtxScanArgs): Promise<void> {
  const runner = context.deps.scan ?? (await import('../scan.js')).runKtxScan;
  context.setExitCode(await runner(args, context.io));
}

type KtxScanModeOption = Extract<KtxScanArgs, { command: 'run' }>['mode'];

function parseScanModeOption(value: string): KtxScanModeOption {
  if (value === 'structural' || value === 'enriched' || value === 'relationships') {
    return value;
  }
  throw new InvalidArgumentError('Allowed choices are structural, enriched, relationships');
}

type KtxRelationshipStatusOption = Extract<KtxScanArgs, { command: 'relationships' }>['status'];
type KtxRelationshipFeedbackDecisionOption = Extract<KtxScanArgs, { command: 'relationshipFeedback' }>['decision'];

function parseRelationshipStatusOption(value: string): KtxRelationshipStatusOption {
  if (value === 'accepted' || value === 'review' || value === 'rejected' || value === 'skipped' || value === 'all') {
    return value;
  }
  throw new InvalidArgumentError('Allowed choices are accepted, review, rejected, skipped, all');
}

function parseRelationshipFeedbackDecisionOption(value: string): KtxRelationshipFeedbackDecisionOption {
  if (value === 'accepted' || value === 'rejected' || value === 'all') {
    return value;
  }
  throw new InvalidArgumentError('Allowed choices are accepted, rejected, all');
}

function parseNonEmptyOption(value: string): string {
  if (value.trim().length === 0) {
    throw new InvalidArgumentError('must not be empty');
  }
  return value;
}

function parseRelationshipCalibrationThreshold(value: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  throw new InvalidArgumentError('Allowed range is 0 through 1');
}

function relationshipDecisionArgs(options: {
  accept?: string;
  reject?: string;
  reviewer?: string;
  note?: string;
  json?: boolean;
}): Pick<
  Extract<KtxScanArgs, { command: 'relationshipDecision' }>,
  'candidateId' | 'decision' | 'reviewer' | 'note' | 'json'
> | null {
  const decisionCount = [options.accept !== undefined, options.reject !== undefined].filter(Boolean).length;
  if (decisionCount > 1) {
    throw new Error('Only one relationship review decision option can be used: --accept and --reject conflict');
  }
  if (options.accept !== undefined) {
    return {
      candidateId: options.accept,
      decision: 'accepted',
      reviewer: options.reviewer ?? 'ktx',
      note: options.note ?? null,
      json: options.json === true,
    };
  }
  if (options.reject !== undefined) {
    return {
      candidateId: options.reject,
      decision: 'rejected',
      reviewer: options.reviewer ?? 'ktx',
      note: options.note ?? null,
      json: options.json === true,
    };
  }
  return null;
}

function collectRelationshipCandidateOption(value: string, previous: string[]): string[] {
  return [...previous, parseNonEmptyOption(value)];
}

export function registerScanCommands(program: Command, context: KtxCliCommandContext): void {
  const scan = program
    .command('scan')
    .description('Run or inspect standalone connection scans')
    .argument('[connectionId]', 'KTX connection id to scan')
    .option(
      '--mode <mode>',
      'Scan mode: structural, enriched, relationships (default: structural)',
      parseScanModeOption,
    )
    .option('--dry-run', 'Run without writing scan results', false)
    .option('--database-introspection-url <url>', 'Daemon URL for live-database introspection')
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    )
    .hook('preAction', (_thisCommand, actionCommand) => {
      context.writeDebug?.('scan', actionCommand);
    })
    .action(async (connectionId: string | undefined, options, command) => {
      if (!connectionId) {
        scan.outputHelp();
        context.io.stderr.write('ktx dev scan requires <connectionId> or a subcommand\n');
        context.setExitCode(1);
        return;
      }
      const mode = options.mode ?? 'structural';
      await runScanArgs(context, {
        command: 'run',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        mode,
        detectRelationships: mode === 'relationships',
        dryRun: options.dryRun === true,
        databaseIntrospectionUrl: options.databaseIntrospectionUrl,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
      });
    });

  scan
    .command('status')
    .description('Print status for a local scan run')
    .argument('<runId>', 'Local scan run id')
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (runId: string, _options: unknown, command) => {
      await runScanArgs(context, {
        command: 'status',
        projectDir: resolveCommandProjectDir(command),
        runId,
      });
    });

  scan
    .command('report')
    .description('Print a local scan report')
    .argument('<runId>', 'Local scan run id')
    .option('--json', 'Print the raw scan report JSON', false)
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (runId: string, options, command) => {
      await runScanArgs(context, {
        command: 'report',
        projectDir: resolveCommandProjectDir(command),
        runId,
        json: options.json === true,
      });
    });

  scan
    .command('relationships')
    .description('Print relationship artifacts for a local scan run')
    .argument('<runId>', 'Local scan run id')
    .option(
      '--status <status>',
      'Relationship status: accepted, review, rejected, skipped, all',
      parseRelationshipStatusOption,
      'review',
    )
    .option('--limit <count>', 'Maximum relationships to print per status', parsePositiveIntegerOption, 25)
    .addOption(
      new Option('--accept <candidateId>', 'Record a reviewer accepted decision for a relationship candidate')
        .argParser(parseNonEmptyOption)
        .conflicts('reject'),
    )
    .addOption(
      new Option('--reject <candidateId>', 'Record a reviewer rejected decision for a relationship candidate')
        .argParser(parseNonEmptyOption)
        .conflicts('accept'),
    )
    .option('--note <text>', 'Attach a note when recording a relationship review decision')
    .option('--reviewer <name>', 'Reviewer name for a relationship review decision')
    .option('--json', 'Print relationship artifacts as JSON', false)
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (runId: string, options, command) => {
      const decision = relationshipDecisionArgs(options);
      if (decision) {
        await runScanArgs(context, {
          command: 'relationshipDecision',
          projectDir: resolveCommandProjectDir(command),
          runId,
          candidateId: decision.candidateId,
          decision: decision.decision,
          reviewer: decision.reviewer,
          note: decision.note,
          json: decision.json,
        });
        return;
      }
      await runScanArgs(context, {
        command: 'relationships',
        projectDir: resolveCommandProjectDir(command),
        runId,
        status: options.status,
        json: options.json === true,
        limit: options.limit,
      });
    });

  scan
    .command('relationship-apply')
    .description('Apply accepted relationship review decisions as manual manifest joins')
    .argument('<runId>', 'Local scan run id')
    .option('--all-accepted', 'Apply all accepted relationship review decisions for the scan run', false)
    .option(
      '--candidate <candidateId>',
      'Apply one accepted relationship review decision',
      collectRelationshipCandidateOption,
      [],
    )
    .option('--dry-run', 'Preview relationships that would be written without rewriting manifest shards', false)
    .option('--json', 'Print the apply result as JSON', false)
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (runId: string, options, command) => {
      const parentOptions = command.parent?.opts() as { dryRun?: boolean } | undefined;
      await runScanArgs(context, {
        command: 'relationshipApply',
        projectDir: resolveCommandProjectDir(command),
        runId,
        applyAllAccepted: options.allAccepted === true,
        candidateIds: options.candidate,
        dryRun: options.dryRun === true || parentOptions?.dryRun === true,
        json: options.json === true,
      });
    });

  scan
    .command('relationship-feedback')
    .description('Export persisted relationship review decisions as calibration labels')
    .option('--connection <connectionId>', 'Only export labels for one KTX connection')
    .option(
      '--decision <decision>',
      'Relationship feedback decision: accepted, rejected, all',
      parseRelationshipFeedbackDecisionOption,
      'all',
    )
    .addOption(new Option('--json', 'Print the export as JSON').default(false).conflicts('jsonl'))
    .addOption(new Option('--jsonl', 'Print labels as newline-delimited JSON').default(false).conflicts('json'))
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (options, command) => {
      await runScanArgs(context, {
        command: 'relationshipFeedback',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connection ?? null,
        decision: options.decision,
        json: options.json === true,
        jsonl: options.jsonl === true,
      });
    });

  scan
    .command('relationship-calibration')
    .description('Summarize relationship feedback labels against current score thresholds')
    .option('--connection <connectionId>', 'Only calibrate labels for one KTX connection')
    .option(
      '--decision <decision>',
      'Relationship feedback decision: accepted, rejected, all',
      parseRelationshipFeedbackDecisionOption,
      'all',
    )
    .option(
      '--accept-threshold <value>',
      'Score threshold treated as predicted accepted',
      parseRelationshipCalibrationThreshold,
      0.85,
    )
    .option(
      '--review-threshold <value>',
      'Score threshold treated as predicted review',
      parseRelationshipCalibrationThreshold,
      0.55,
    )
    .option('--json', 'Print the calibration report as JSON', false)
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (options, command) => {
      await runScanArgs(context, {
        command: 'relationshipCalibration',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connection ?? null,
        decision: options.decision,
        acceptThreshold: options.acceptThreshold,
        reviewThreshold: options.reviewThreshold,
        json: options.json === true,
      });
    });

  scan
    .command('relationship-thresholds')
    .description('Evaluate relationship feedback labels for offline threshold advice')
    .option('--connection <connectionId>', 'Only evaluate labels for one KTX connection')
    .option(
      '--min-total-labels <count>',
      'Minimum scored labels before advice can be ready',
      parsePositiveIntegerOption,
      20,
    )
    .option(
      '--min-accepted-labels <count>',
      'Minimum accepted labels before advice can be ready',
      parsePositiveIntegerOption,
      5,
    )
    .option(
      '--min-rejected-labels <count>',
      'Minimum rejected labels before advice can be ready',
      parsePositiveIntegerOption,
      5,
    )
    .option('--json', 'Print the threshold advice report as JSON', false)
    .addHelpText(
      'after',
      '\n--project-dir is inherited from `ktx dev scan` (default: KTX_PROJECT_DIR or current working directory).\n',
    )
    .action(async (options, command) => {
      await runScanArgs(context, {
        command: 'relationshipThresholds',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connection ?? null,
        minTotalLabels: options.minTotalLabels,
        minAcceptedLabels: options.minAcceptedLabels,
        minRejectedLabels: options.minRejectedLabels,
        json: options.json === true,
      });
    });
}
