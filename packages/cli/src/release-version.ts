const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertCliVersion(value: unknown, source: string): string {
  if (typeof value !== 'string' || !semverPattern.test(value)) {
    throw new Error(`Invalid KTX CLI version in ${source}`);
  }
  return value;
}
