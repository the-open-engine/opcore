'use strict';

const path = require('path');
const { installRelease } = require('./install');
const { verifyCleanupInputs, runUninstaller } = require('./cli');
const { installStandalone, preflightStandalone } = require('./standalone');
const { withInstallLock } = require('./lock');

async function install(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '..'));
  return withInstallLock(packageRoot, () => installRelease({
    ...options,
    packageRoot,
    installStandalone,
    preflightStandalone,
    rollbackInstallation: (state, owners, environment) => {
      const script = verifyCleanupInputs(state, owners);
      (options.runUninstaller || runUninstaller)(state, environment, script);
    },
  }));
}

module.exports = { install };
