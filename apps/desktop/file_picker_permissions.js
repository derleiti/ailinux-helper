'use strict';

/**
 * Chromium can leave a directory picker stuck after it rejects a protected
 * system directory. Electron exposes this event so the user can safely retry
 * or explicitly approve that particular folder. Never silently override the
 * filesystem guard, and never honor events from an untrusted renderer origin.
 */
function installRestrictedDirectoryPolicy(ses, { isTrustedDocument, dialog, getWindow }) {
  ses.on('file-system-access-restricted', async (_event, details, callback) => {
    let answered = false;
    const finish = (action) => {
      if (answered) return;
      answered = true;
      callback(action);
    };

    if (!details || details.isDirectory !== true || !isTrustedDocument(details.origin || '')) {
      finish('deny');
      return;
    }
    try {
      let parent = getWindow();
      if (parent?.isDestroyed?.()) parent = null;
      const options = {
        type: 'warning',
        title: 'AILinux Helper - Protected folder',
        message: 'The selected folder is protected by Electron.',
        detail: 'Folder: ' + String(details.path || '(unknown)') + '\n\n' +
          'Only allow a protected folder when you intend to share it with your connected AI session.',
        buttons: ['Choose another folder', 'Allow this folder', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const choice = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      finish(choice.response === 1 ? 'allow' : choice.response === 0 ? 'tryAgain' : 'deny');
    } catch {
      finish('deny');
    }
  });
}

module.exports = { installRestrictedDirectoryPolicy };
