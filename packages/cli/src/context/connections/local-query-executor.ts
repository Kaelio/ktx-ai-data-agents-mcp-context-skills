import { driverRegistrations, getDriverRegistration } from './drivers.js';
import { createPostgresQueryExecutor } from './postgres-query-executor.js';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
  KtxSqlQueryExecutorPort,
} from './query-executor.js';
import { createSqliteQueryExecutor } from './sqlite-query-executor.js';
import type { KtxConnectionDriver } from '../scan/types.js';

export interface DefaultLocalQueryExecutorOptions {
  postgres?: KtxSqlQueryExecutorPort;
  sqlite?: KtxSqlQueryExecutorPort;
}

function driverFor(input: KtxSqlQueryExecutionInput): string {
  return String(input.connection?.driver ?? '').toLowerCase();
}

function localExecutorMap(
  options: DefaultLocalQueryExecutorOptions,
): Partial<Record<KtxConnectionDriver, KtxSqlQueryExecutorPort>> {
  const wiredExecutors: Partial<Record<KtxConnectionDriver, KtxSqlQueryExecutorPort>> = {
    postgres: options.postgres ?? createPostgresQueryExecutor(),
    sqlite: options.sqlite ?? createSqliteQueryExecutor(),
  };

  const executors: Partial<Record<KtxConnectionDriver, KtxSqlQueryExecutorPort>> = {};
  for (const registration of Object.values(driverRegistrations)) {
    if (!registration.hasLocalQueryExecutor) continue;
    const executor = wiredExecutors[registration.driver];
    if (executor) {
      executors[registration.driver] = executor;
    }
  }
  return executors;
}

export function createDefaultLocalQueryExecutor(options: DefaultLocalQueryExecutorOptions = {}): KtxSqlQueryExecutorPort {
  const executors = localExecutorMap(options);

  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const driver = driverFor(input);
      const registration = getDriverRegistration(driver);
      if (!registration?.hasLocalQueryExecutor) {
        throw new Error(`No local query executor is configured for driver "${input.connection?.driver ?? 'unknown'}".`);
      }

      const executor = executors[registration.driver];
      if (!executor) {
        throw new Error(
          `Local query executor flag is enabled for driver "${registration.driver}", but no executor factory is wired.`,
        );
      }
      return executor.execute(input);
    },
  };
}
