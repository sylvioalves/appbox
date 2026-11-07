'use strict';

const { safeStorage } = require('electron');

/* Without a desktop keyring Electron falls back to a fixed built-in
 * key, which does not protect the stored secret.
 */
function keyringSecure() {
  return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

module.exports = { keyringSecure };
