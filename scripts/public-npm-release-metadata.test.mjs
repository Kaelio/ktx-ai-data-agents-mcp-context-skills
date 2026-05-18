import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicNpmPackageVersionToPythonVersion } from './public-npm-release-metadata.mjs';

describe('publicNpmPackageVersionToPythonVersion', () => {
  it('keeps stable public npm versions unchanged for Python wheels', () => {
    assert.equal(publicNpmPackageVersionToPythonVersion('1.2.3'), '1.2.3');
  });

  it('converts semantic-release rc versions to PEP 440 rc versions', () => {
    assert.equal(publicNpmPackageVersionToPythonVersion('0.1.0-rc.1'), '0.1.0rc1');
    assert.equal(publicNpmPackageVersionToPythonVersion('2.0.0-rc.12'), '2.0.0rc12');
  });

  it('rejects unsupported prerelease and build metadata forms', () => {
    assert.throws(
      () => publicNpmPackageVersionToPythonVersion('1.2.3-beta.1'),
      /Unsupported public npm prerelease for Python runtime version/,
    );
    assert.throws(
      () => publicNpmPackageVersionToPythonVersion('1.2.3+build.1'),
      /Unsupported public npm build metadata for Python runtime version/,
    );
  });
});
