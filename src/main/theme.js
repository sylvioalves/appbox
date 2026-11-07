'use strict';

const { nativeTheme } = require('electron');

const DARK = { bg: '#1e1e2e', fg: '#cdd6f4' };
const LIGHT = { bg: '#eff1f5', fg: '#4c4f69' };

/* Shell colors of the window frame, matching the :root palette of the
 * pages under the current system or chosen theme.
 */
function colors() {
  return nativeTheme.shouldUseDarkColors ? DARK : LIGHT;
}

module.exports = { colors };
