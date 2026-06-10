import {
  getDriverRegistration,
  listSupportedDrivers,
} from './context/connections/drivers.js';
import type { KtxLocalProject } from './context/project/project.js';
import type { KtxScanConnector } from './context/scan/types.js';

const SUPPORTED_DRIVERS = listSupportedDrivers().join(', ');

export async function createKtxCliScanConnector(
  project: KtxLocalProject,
  connectionId: string,
): Promise<KtxScanConnector> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const driver = String(connection.driver ?? '').toLowerCase();
  if (!driver) {
    throw new Error(
      `Connection "${connectionId}" has no \`driver\` field in ktx.yaml. Supported drivers: ${SUPPORTED_DRIVERS}.`,
    );
  }

  const registration = getDriverRegistration(driver);
  if (!registration) {
    throw new Error(
      `Connection "${connectionId}" uses driver "${driver}", which has no native standalone ktx scan connector. Supported drivers: ${SUPPORTED_DRIVERS}.`,
    );
  }

  const connectorModule = await registration.load();
  if (!connectorModule.isConnectionConfig(connection)) {
    throw invalidConnectionConfigError(connectionId, driver);
  }
  return connectorModule.createScanConnector({
    connectionId,
    connection,
    projectDir: project.projectDir,
  });
}

function invalidConnectionConfigError(connectionId: string, driver: string): Error {
  return new Error(
    `Connection "${connectionId}" uses driver "${driver}" but its configuration in ktx.yaml does not match the expected shape for that driver. Check the required fields for ${driver} (e.g. url/host/database).`,
  );
}
