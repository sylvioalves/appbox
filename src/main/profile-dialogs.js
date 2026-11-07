'use strict';

const path = require('path');
const { guard, guardOn } = require('./ipc');

/* The export and import dialogs of the settings menu and the modal
 * passphrase prompt they open. deps supplies the windows, the Electron
 * app and dialog objects, the profile and config modules and the
 * status bar setter, so the main module keeps its state to itself.
 */
function createProfileDialogs(deps) {
  const {
    app, dialog, profile, config, fmtBytes, openDialogWindow, mainWindow, settingsWindow, settings, setTransfer, restart,
  } = deps;
  let promptWin = null;
  let promptSpec = null;

  const fromPrompt = (e) => (
    promptWin !== null && !promptWin.isDestroyed() && e.sender === promptWin.webContents ? promptWin : null);

  /* A modal passphrase prompt: resolves with the text, or null when the
   * window is closed.
   */
  function askPassphrase({ title, message, confirm }) {
    return new Promise((resolve) => {
      if (promptSpec) {
        const old = promptSpec;
        promptSpec = null;
        old.resolve(null);
      }
      if (promptWin && !promptWin.isDestroyed()) {
        promptWin.close();
      }
      const settingsWin = settingsWindow();
      const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : mainWindow();
      const w = openDialogWindow({
        title, page: 'prompt', width: 480, height: confirm ? 300 : 250, parent,
      });
      promptWin = w;
      promptSpec = { title, message, confirm: Boolean(confirm), resolve, win: w };
      w.on('closed', () => {
        if (promptWin === w) {
          promptWin = null;
        }
        if (promptSpec && promptSpec.win === w) {
          const done = promptSpec.resolve;
          promptSpec = null;
          done(null);
        }
      });
    });
  }

  async function exportProfileDialog() {
    const win = mainWindow();
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Export profile',
      message: 'What should the profile contain?',
      detail: 'Settings: the app list, properties and window state. Sessions add the logins of every app, '
        + 'the mail sign-in and the GitHub token, in an archive encrypted with a passphrase of your choice. '
        + 'The mail password and the GitHub token only open on a machine with the same keyring. '
        + 'Delete an archive with sessions once imported.',
      buttons: ['Settings only', 'Settings and sessions', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) {
      return null;
    }
    const sessions = choice.response === 1;
    let passphrase = '';
    if (sessions) {
      passphrase = await askPassphrase({
        title: 'Export profile',
        message: 'Choose a passphrase for the archive. It is asked again when the profile is imported.',
        confirm: true,
      });
      if (passphrase === null) {
        return null;
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const ext = sessions ? 'tar.gz.enc' : 'tar.gz';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export profile',
      defaultPath: path.join(config.downloadDir(settings()), `appbox-profile-${stamp}.${ext}`),
      filters: [{ name: 'Appbox profile', extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) {
      return null;
    }
    let text;
    try {
      const out = await profile.exportProfile(r.filePath, { sessions, passphrase, version: app.getVersion() });
      text = `Profile exported to ${out.file} (${fmtBytes(out.size)}${out.encrypted ? ', encrypted' : ''})`;
    } catch (err) {
      text = `Profile export failed: ${err.message}`;
    }
    setTransfer(text, 12000);
    return text;
  }

  async function importProfileDialog() {
    const win = mainWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Import profile',
      defaultPath: config.downloadDir(settings()),
      filters: [{ name: 'Appbox profile', extensions: ['tar.gz', 'tgz', 'enc'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) {
      return null;
    }
    let manifest;
    let passphrase = '';
    for (;;) {
      try {
        manifest = await profile.stageImport(r.filePaths[0], passphrase);
        break;
      } catch (err) {
        if (err.code !== 'ENCRYPTED' && err.code !== 'BADPASS') {
          await dialog.showMessageBox(win, { type: 'error', title: 'Import profile', message: `Cannot import: ${err.message}` });
          return null;
        }
        passphrase = await askPassphrase({
          title: 'Import profile',
          message: err.code === 'BADPASS' ? 'Wrong passphrase, try again.' : 'The archive is encrypted. Enter its passphrase.',
          confirm: false,
        });
        if (passphrase === null) {
          return null;
        }
      }
    }
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Import profile',
      message: 'Replace the current configuration and restart Appbox?',
      detail: `Exported ${manifest.exported_at} from ${manifest.host} (Appbox ${manifest.version})`
        + `${manifest.sessions ? ', with app sessions' : ', settings only'}. The current settings`
        + `${manifest.sessions ? ' and sessions' : ''} will be replaced.`
        + `${manifest.launch.length > 0 ? `\n\nThis profile runs these commands when their app is opened:\n${manifest.launch.slice(0, 20).join('\n')}` : ''}`,
      buttons: ['Replace and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      profile.clearPendingImport();
      return null;
    }
    try {
      profile.commitImport();
    } catch (err) {
      profile.clearPendingImport();
      await dialog.showMessageBox(win, { type: 'error', title: 'Import profile', message: `Cannot import: ${err.message}` });
      return null;
    }
    restart();
    return 'restarting';
  }

  function registerPromptIpc(ipcMain) {
    ipcMain.handle('prompt:get', guard(fromPrompt, () => (promptSpec
      ? { title: promptSpec.title, message: promptSpec.message, confirm: promptSpec.confirm } : null)));
    ipcMain.on('prompt:submit', guardOn(fromPrompt, (w, value) => {
      if (!promptSpec) {
        return;
      }
      const { resolve } = promptSpec;
      promptSpec = null;
      w.close();
      resolve(String(value || ''));
    }));
    ipcMain.on('prompt:cancel', guardOn(fromPrompt, (w) => w.close()));
  }

  return { askPassphrase, exportProfileDialog, importProfileDialog, registerPromptIpc };
}

module.exports = { createProfileDialogs };
