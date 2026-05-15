const { createReleaseConfig } = require('./scripts/semantic-release-config.cjs');

module.exports = createReleaseConfig(process.env);
