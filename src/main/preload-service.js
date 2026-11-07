'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const clicks = new Map();

ipcRenderer.on('appbox:notify-click', (e, id) => {
  const cb = clicks.get(id);
  clicks.delete(id);
  if (cb) {
    cb();
  }
});
ipcRenderer.on('appbox:notify-close', (e, id) => clicks.delete(id));

contextBridge.exposeInMainWorld('__appbox', {
  notify: async (payload, onClick) => {
    const id = await ipcRenderer.invoke('appbox:notify', {
      title: String(payload.title || ''),
      body: String(payload.body || ''),
      tag: String(payload.tag || ''),
    });
    if (typeof onClick === 'function') {
      clicks.set(id, onClick);
    }
    return id;
  },
  close: (id) => {
    clicks.delete(id);
    ipcRenderer.send('appbox:notify-close', id);
  },
});

/* Runs in the page's world before any page script, so the page never
 * sees the native Notification.
 */
webFrame.executeJavaScript(`(() => {
  if (window.__appboxShim) return;
  window.__appboxShim = true;
  class AppboxNotification extends EventTarget {
    constructor(title, opts = {}) {
      super();
      this.title = title;
      this.body = opts.body || '';
      this.icon = opts.icon || '';
      this.tag = opts.tag || '';
      this.data = opts.data;
      this.onclick = null;
      this.onshow = null;
      this.onclose = null;
      this.onerror = null;
      this._id = null;
      window.__appbox.notify({ title, body: this.body, tag: this.tag }, () => {
        const ev = new Event('click');
        this.dispatchEvent(ev);
        if (typeof this.onclick === 'function') this.onclick(ev);
      }).then((id) => {
        this._id = id;
        const ev = new Event('show');
        this.dispatchEvent(ev);
        if (typeof this.onshow === 'function') this.onshow(ev);
      });
    }
    close() {
      if (this._id !== null) window.__appbox.close(this._id);
      const ev = new Event('close');
      this.dispatchEvent(ev);
      if (typeof this.onclose === 'function') this.onclose(ev);
    }
    static get permission() { return 'granted'; }
    static get maxActions() { return 0; }
    static requestPermission(cb) {
      const p = Promise.resolve('granted');
      if (typeof cb === 'function') p.then(cb);
      return p;
    }
  }
  window.Notification = AppboxNotification;
})();`);
