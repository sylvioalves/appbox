'use strict';

const path = require('path');

/* Runs the one-shot command line flags. Returns false when the app
 * should start, otherwise true or a promise that resolves to true
 * once the work is done and the process may exit.
 */
function handleCli(argv, deps) {
  const { profile, getVersion, fmtBytes, setAutostart, autostartEnabled, requestSingleInstanceLock } = deps;
  /* Read once, so no child process inherits it. */
  const passphrase = process.env.APPBOX_PASSPHRASE || '';
  delete process.env.APPBOX_PASSPHRASE;
  if (argv.includes('--version')) {
    console.log(`Appbox ${getVersion()}`);
    return true;
  }
  const ex = argv.indexOf('--export-profile');
  if (ex !== -1) {
    const sessions = argv.includes('--with-sessions');
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.resolve(argv[ex + 1] || `appbox-profile-${stamp}.tar.gz${sessions ? '.enc' : ''}`);
    if (sessions && !passphrase) {
      console.error('export refused: set APPBOX_PASSPHRASE to encrypt the sessions');
      process.exitCode = 1;
      return true;
    }
    return profile.exportProfile(file, { sessions, passphrase, version: getVersion() }).then((out) => {
      console.log(`exported ${out.file} (${fmtBytes(out.size)}${out.sessions ? ', with sessions' : ''}${out.encrypted ? ', encrypted' : ''})`);
    }, (err) => {
      console.error(`export failed: ${err.message}`);
      process.exitCode = 1;
    }).then(() => true);
  }
  const im = argv.indexOf('--import-profile');
  if (im !== -1) {
    if (!requestSingleInstanceLock()) {
      console.error('import refused: Appbox is running, quit it first');
      process.exitCode = 1;
      return true;
    }
    const file = path.resolve(String(argv[im + 1] || ''));
    return profile.stageImport(file, passphrase).then((manifest) => {
      if (manifest.launch.length > 0 && !argv.includes('--yes')) {
        profile.clearPendingImport();
        console.error(`import refused: the profile runs commands, pass --yes to accept them:\n${manifest.launch.join('\n')}`);
        process.exitCode = 1;
        return;
      }
      profile.commitImport();
      const done = profile.applyPendingImport();
      console.log(`imported profile from ${manifest.host} (${manifest.exported_at}): ${done.applied.join(', ')}`);
    }, (err) => {
      console.error(err.code === 'ENCRYPTED' ? 'import failed: the archive is encrypted, set APPBOX_PASSPHRASE'
        : `import failed: ${err.message}`);
      process.exitCode = 1;
    }).then(() => true);
  }
  const i = argv.indexOf('--autostart');
  if (i !== -1) {
    return Promise.resolve(setAutostart(argv[i + 1] !== 'off')).then(() => {
      console.log(`autostart ${autostartEnabled() ? 'enabled' : 'disabled'}`);
    }, (err) => {
      console.error(`autostart failed: ${err.message}`);
      process.exitCode = 1;
    }).then(() => true);
  }
  return false;
}

module.exports = { handleCli };
