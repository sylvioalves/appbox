'use strict';

/* Wraps an ipcMain.handle handler so it runs only for an allowed
 * sender. allowed(event) returns the context the handler works on
 * (a window, a view, an account) or null, and fn receives that
 * context in place of the event.
 */
function guard(allowed, fn) {
  return async (e, ...args) => {
    const ctx = allowed(e);
    if (!ctx) {
      throw new Error('ipc: sender not allowed');
    }
    return fn(ctx, ...args);
  };
}

/* The ipcMain.on counterpart: a message from any other sender is
 * dropped.
 */
function guardOn(allowed, fn) {
  return (e, ...args) => {
    const ctx = allowed(e);
    if (ctx) {
      fn(ctx, ...args);
    }
  };
}

module.exports = { guard, guardOn };
