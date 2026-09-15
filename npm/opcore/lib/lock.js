'use strict';

const fs = require('fs');
const path = require('path');

function withInstallLock(packageRoot, action) {
  const directory = path.join(packageRoot, '.opcore-install.lock');
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    throw new Error(`INSTALL_BUSY: another setup or removal holds ${directory}; ` +
      'if interrupted, confirm no installer is running before removing this empty lock directory');
  }
  const release = () => fs.rmdirSync(directory);
  let result;
  try { result = action(); } catch (cause) {
    release();
    throw cause;
  }
  if (result instanceof Promise) return result.finally(release);
  release();
  return result;
}

module.exports = { withInstallLock };
