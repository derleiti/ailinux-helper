'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only the packaged public application tree, never user data or symlink targets.
function normalizeLinuxPackagePermissions(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, (stat.mode & 0o7777) | 0o055);
    for (const name of fs.readdirSync(root)) {
      normalizeLinuxPackagePermissions(path.join(root, name));
    }
  } else if (stat.isFile()) {
    const executable = (stat.mode & 0o111) !== 0;
    fs.chmodSync(root, (stat.mode & 0o7777) | 0o044 | (executable ? 0o011 : 0));
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    normalizeLinuxPackagePermissions(context.appOutDir);
  }
};
module.exports.normalizeLinuxPackagePermissions = normalizeLinuxPackagePermissions;
