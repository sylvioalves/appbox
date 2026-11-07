'use strict';

/* Minimal D-Bus client for the desktop portals: connects to the
 * session bus, authenticates, says Hello and exchanges messages made
 * of bytes, booleans, unsigned integers, strings, object paths,
 * signatures, variants, arrays, dictionaries and structs. Outgoing
 * messages are little endian, incoming ones are read either way.
 */
const net = require('net');
const os = require('os');

const CALL = 1;
const RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;
const FIELDS = ['', 'path', 'interface', 'member', 'errorName', 'replySerial', 'destination', 'sender', 'signature'];
const FIELD_TYPES = { path: 'o', interface: 's', member: 's', errorName: 's', replySerial: 'u', destination: 's', sender: 's', signature: 'g' };
const BUS = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus' };
const PORTAL = { destination: 'org.freedesktop.portal.Desktop', path: '/org/freedesktop/portal/desktop' };

function alignment(type) {
  switch (type[0]) {
    case 'y': case 'g': case 'v': return 1;
    case 'n': case 'q': return 2;
    case 'b': case 'i': case 'u': case 's': case 'o': case 'a': case 'h': return 4;
    case 'x': case 't': case 'd': case '(': case '{': return 8;
    default: throw new Error(`unsupported type ${type}`);
  }
}

function typeEnd(sig, i) {
  const c = sig[i];
  if (c === 'a') {
    return typeEnd(sig, i + 1);
  }
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let j = i + 1;
    while (sig[j] !== close) {
      if (j >= sig.length) {
        throw new Error(`bad signature ${sig}`);
      }
      j = typeEnd(sig, j);
    }
    return j + 1;
  }
  if (c === undefined || !'ybnqiuxtdsogvh'.includes(c)) {
    throw new Error(`bad signature ${sig}`);
  }
  return i + 1;
}

function splitSignature(sig) {
  const out = [];
  let i = 0;
  while (i < sig.length) {
    const end = typeEnd(sig, i);
    out.push(sig.slice(i, end));
    i = end;
  }
  return out;
}

class Writer {
  constructor() {
    this.buf = Buffer.alloc(256);
    this.len = 0;
  }

  ensure(n) {
    while (this.len + n > this.buf.length) {
      const grown = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(grown);
      this.buf = grown;
    }
  }

  pad(n) {
    const p = (n - (this.len % n)) % n;
    this.ensure(p);
    this.buf.fill(0, this.len, this.len + p);
    this.len += p;
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.len] = v;
    this.len += 1;
  }

  u32(v) {
    this.pad(4);
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
  }

  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }

  write(type, value) {
    switch (type[0]) {
      case 'y':
        this.u8(value);
        break;
      case 'b':
        this.u32(value ? 1 : 0);
        break;
      case 'u':
        this.u32(value);
        break;
      case 's':
      case 'o': {
        const b = Buffer.from(String(value), 'utf8');
        this.u32(b.length);
        this.bytes(b);
        this.u8(0);
        break;
      }
      case 'g': {
        const b = Buffer.from(String(value), 'ascii');
        this.u8(b.length);
        this.bytes(b);
        this.u8(0);
        break;
      }
      case 'v':
        this.write('g', value.type);
        this.write(value.type, value.value);
        break;
      case 'a': {
        const elem = type.slice(1);
        this.u32(0);
        const lenAt = this.len - 4;
        this.pad(alignment(elem));
        const start = this.len;
        if (elem[0] === '{') {
          for (const entry of Object.entries(value)) {
            this.write(elem, entry);
          }
        } else {
          for (const v of value) {
            this.write(elem, v);
          }
        }
        this.buf.writeUInt32LE(this.len - start, lenAt);
        break;
      }
      case '(':
      case '{': {
        this.pad(8);
        splitSignature(type.slice(1, -1)).forEach((t, i) => this.write(t, value[i]));
        break;
      }
      default:
        throw new Error(`unsupported type ${type}`);
    }
  }

  output() {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  constructor(buf, littleEndian) {
    this.buf = buf;
    this.pos = 0;
    this.le = littleEndian;
  }

  pad(n) {
    this.pos += (n - (this.pos % n)) % n;
  }

  u8() {
    const v = this.buf[this.pos];
    this.pos += 1;
    return v;
  }

  u32() {
    this.pad(4);
    const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  read(type) {
    switch (type[0]) {
      case 'y':
        return this.u8();
      case 'b':
        return this.u32() !== 0;
      case 'u':
        return this.u32();
      case 'i':
        return this.u32() | 0;
      case 's':
      case 'o': {
        const n = this.u32();
        const s = this.buf.toString('utf8', this.pos, this.pos + n);
        this.pos += n + 1;
        return s;
      }
      case 'g': {
        const n = this.u8();
        const s = this.buf.toString('ascii', this.pos, this.pos + n);
        this.pos += n + 1;
        return s;
      }
      case 'v':
        return this.read(this.read('g'));
      case 'a': {
        const elem = type.slice(1);
        const n = this.u32();
        this.pad(alignment(elem));
        const end = this.pos + n;
        if (elem[0] === '{') {
          const out = {};
          while (this.pos < end) {
            const [k, v] = this.read(elem);
            out[k] = v;
          }
          return out;
        }
        const out = [];
        while (this.pos < end) {
          out.push(this.read(elem));
        }
        return out;
      }
      case '(':
      case '{':
        this.pad(8);
        return splitSignature(type.slice(1, -1)).map((t) => this.read(t));
      default:
        throw new Error(`unsupported type ${type}`);
    }
  }
}

/* A message is { type, serial, flags, path, interface, member,
 * errorName, replySerial, destination, sender, signature, body },
 * with body the array of the arguments the signature describes.
 */
function encode(msg) {
  const body = new Writer();
  const signature = msg.signature || '';
  splitSignature(signature).forEach((t, i) => body.write(t, msg.body[i]));
  const bodyBytes = body.output();
  const fields = [];
  FIELDS.forEach((name, code) => {
    const v = name === 'signature' ? (signature || undefined) : msg[name];
    if (name !== '' && v !== undefined) {
      fields.push([code, { type: FIELD_TYPES[name], value: v }]);
    }
  });
  const h = new Writer();
  h.write('y', 'l'.charCodeAt(0));
  h.write('y', msg.type);
  h.write('y', msg.flags || 0);
  h.write('y', 1);
  h.write('u', bodyBytes.length);
  h.write('u', msg.serial);
  h.write('a(yv)', fields);
  h.pad(8);
  return Buffer.concat([h.output(), bodyBytes]);
}

/* Returns { msg, length } for the first complete message in buf, or
 * null when more bytes are needed.
 */
function decode(buf) {
  if (buf.length < 16) {
    return null;
  }
  const le = buf[0] === 'l'.charCodeAt(0);
  const r = new Reader(buf, le);
  r.u8();
  const type = r.u8();
  const flags = r.u8();
  r.u8();
  const bodyLen = r.u32();
  const serial = r.u32();
  const fieldsLen = r.u32();
  r.pos = 12;
  const headerLen = 16 + fieldsLen;
  const length = headerLen + ((8 - (headerLen % 8)) % 8) + bodyLen;
  if (buf.length < length) {
    return null;
  }
  const msg = { type, flags, serial, body: [] };
  for (const [code, value] of r.read('a(yv)')) {
    if (FIELDS[code]) {
      msg[FIELDS[code]] = value;
    }
  }
  r.pad(8);
  msg.body = splitSignature(msg.signature || '').map((t) => r.read(t));
  return { msg, length };
}

function socketPath(address) {
  for (const entry of String(address || '').split(';')) {
    if (!entry.startsWith('unix:')) {
      continue;
    }
    const kv = {};
    for (const pair of entry.slice(5).split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        kv[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
      }
    }
    if (kv.path) {
      return kv.path;
    }
    if (kv.abstract) {
      return `\0${kv.abstract}`;
    }
  }
  throw new Error('no unix session bus address');
}

class Bus {
  constructor(socket) {
    this.socket = socket;
    this.serial = 0;
    this.pending = new Map();
    this.listeners = [];
    this.name = null;
    this.buf = Buffer.alloc(0);
    this.closed = new Promise((resolve, reject) => {
      socket.on('error', (err) => reject(err));
      socket.on('close', () => reject(new Error('bus connection closed')));
    });
    this.closed.catch((err) => {
      for (const p of this.pending.values()) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /* Connects to the session bus at the address, authenticates with
   * the user id and says Hello, so the bus has assigned a name.
   */
  static connect(address = process.env.DBUS_SESSION_BUS_ADDRESS) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath(address));
      const bus = new Bus(socket);
      let text = '';
      let ready = false;
      socket.once('error', reject);
      socket.on('connect', () => {
        const uid = Buffer.from(String(os.userInfo().uid), 'ascii').toString('hex');
        socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
      });
      socket.on('data', (chunk) => {
        if (ready) {
          bus.feed(chunk);
          return;
        }
        text += chunk.toString('latin1');
        const nl = text.indexOf('\r\n');
        if (nl === -1) {
          return;
        }
        const line = text.slice(0, nl);
        if (!line.startsWith('OK ')) {
          socket.destroy();
          reject(new Error(`bus authentication failed: ${line}`));
          return;
        }
        ready = true;
        socket.write('BEGIN\r\n');
        bus.feed(Buffer.from(text.slice(nl + 2), 'latin1'));
        bus.call({ ...BUS, member: 'Hello' }).then((body) => {
          bus.name = body[0];
          resolve(bus);
        }, reject);
      });
    });
  }

  feed(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      let out;
      try {
        out = decode(this.buf);
      } catch (err) {
        this.socket.destroy(err);
        return;
      }
      if (!out) {
        return;
      }
      this.buf = this.buf.subarray(out.length);
      this.dispatch(out.msg);
    }
  }

  dispatch(msg) {
    if (msg.type === RETURN || msg.type === ERROR) {
      const p = this.pending.get(msg.replySerial);
      if (!p) {
        return;
      }
      this.pending.delete(msg.replySerial);
      if (msg.type === ERROR) {
        p.reject(new Error(`${msg.errorName}: ${msg.body[0] || ''}`));
      } else {
        p.resolve(msg.body);
      }
    } else if (msg.type === SIGNAL) {
      for (const fn of this.listeners) {
        fn(msg);
      }
    }
  }

  /* Sends a method call and resolves with the reply arguments. */
  call(msg) {
    this.serial += 1;
    const serial = this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.socket.write(encode({ ...msg, type: CALL, serial, body: msg.body || [] }));
    });
  }

  onSignal(fn) {
    this.listeners.push(fn);
  }

  close() {
    this.socket.destroy();
  }
}

/* Asks the Background portal for the autostart entry and resolves
 * with its answer: { response, background, autostart }, response
 * being 0 when granted, 1 when the user declined and 2 otherwise.
 * The commandline is run at login by the portal's own launcher.
 */
async function requestBackground({ autostart, commandline, reason }, address) {
  const bus = await Bus.connect(address);
  try {
    const token = `appbox${process.pid}_${Date.now().toString(36)}`;
    const handle = `/org/freedesktop/portal/desktop/request/${bus.name.slice(1).replace(/\./g, '_')}/${token}`;
    const handles = new Set([handle]);
    const response = new Promise((resolve) => {
      bus.onSignal((m) => {
        if (m.interface === 'org.freedesktop.portal.Request' && m.member === 'Response' && handles.has(m.path)) {
          resolve(m.body);
        }
      });
    });
    const [path] = await bus.call({
      ...PORTAL,
      interface: 'org.freedesktop.portal.Background',
      member: 'RequestBackground',
      signature: 'sa{sv}',
      body: ['', {
        handle_token: { type: 's', value: token },
        reason: { type: 's', value: String(reason || '') },
        autostart: { type: 'b', value: Boolean(autostart) },
        commandline: { type: 'as', value: commandline.map(String) },
        'dbus-activatable': { type: 'b', value: false },
      }],
    });
    handles.add(path);
    const [code, results] = await Promise.race([response, bus.closed]);
    return { response: code, background: Boolean(results.background), autostart: Boolean(results.autostart) };
  } finally {
    bus.close();
  }
}

module.exports = { requestBackground, Bus, encode, decode, splitSignature, socketPath, CALL, RETURN, ERROR, SIGNAL };
