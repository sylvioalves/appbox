'use strict';

const tls = require('tls');
const { EventEmitter } = require('events');

const CRLF = '\r\n';
const MAX_DEPTH = 64;
const MAX_LITERAL = 100 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_RESPONSE = 2 * MAX_LITERAL;
/* Untagged responses and their bytes kept for one command. */
const MAX_UNTAGGED = 20000;
const MAX_COMMAND_BYTES = 256 * 1024 * 1024;
/* Longest wait for a command to complete, whatever the data rate. */
const COMMAND_DEADLINE = 10 * 60 * 1000;

class ImapError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'IMAP';
  }
}

/* Accumulates socket data and yields one complete server response at a
 * time as a list of text segments and literal buffers.
 */
class ResponseReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.chunks = [];
    this.chunksLen = 0;
    /* Segments and byte count of the response being received. */
    this.segments = [];
    this.bytes = 0;
    /* Literal being received: { size, have }. */
    this.pending = null;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.chunksLen += chunk.length;
  }

  /* Chunks are joined once a pending literal can be completed, not once
   * per chunk, and consumed bytes are dropped before returning.
   */
  next() {
    if (this.pending && this.buf.length + this.chunksLen < this.pending.size) {
      this.pending.have = this.buf.length + this.chunksLen;
      return null;
    }
    if (this.chunks.length > 0) {
      this.buf = Buffer.concat(this.buf.length > 0 ? [this.buf, ...this.chunks] : this.chunks);
      this.chunks = [];
      this.chunksLen = 0;
    }
    for (;;) {
      if (this.pending) {
        const { size } = this.pending;
        if (this.buf.length < size) {
          this.pending.have = this.buf.length;
          return null;
        }
        this.segments.push(this.buf.subarray(0, size));
        this.buf = this.buf.subarray(size);
        this.pending = null;
      }
      const eol = this.buf.indexOf(CRLF, 0, 'latin1');
      if (eol === -1) {
        if (this.buf.length > MAX_LINE) {
          throw new ImapError('line too long', 'PROTOCOL');
        }
        return null;
      }
      const line = this.buf.toString('latin1', 0, eol);
      this.buf = this.buf.subarray(eol + 2);
      this.segments.push(line);
      this.bytes += eol + 2;
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) {
        const segments = this.segments;
        this.segments = [];
        this.bytes = 0;
        if (this.buf.length === 0) {
          this.buf = Buffer.alloc(0);
        }
        return segments;
      }
      const size = Number(m[1]);
      if (size > MAX_LITERAL) {
        throw new ImapError('literal too large', 'PROTOCOL');
      }
      this.bytes += size;
      if (this.bytes > MAX_RESPONSE) {
        throw new ImapError('response too large', 'PROTOCOL');
      }
      this.pending = { size, have: Math.min(size, this.buf.length) };
    }
  }
}

function tokenize(segments) {
  const tokens = [];
  for (const seg of segments) {
    if (Buffer.isBuffer(seg)) {
      tokens.push({ t: 'lit', v: seg });
      continue;
    }
    let i = 0;
    while (i < seg.length) {
      const c = seg[i];
      if (c === ' ') {
        i++;
      } else if (c === '(' || c === ')') {
        tokens.push({ t: c });
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let out = '';
        while (j < seg.length && seg[j] !== '"') {
          if (seg[j] === '\\') {
            j++;
          }
          out += seg[j];
          j++;
        }
        tokens.push({ t: 'str', v: out });
        i = j + 1;
      } else {
        let j = i;
        let depth = 0;
        while (j < seg.length) {
          const d = seg[j];
          if (depth === 0 && (d === ' ' || d === '(' || d === ')')) {
            break;
          }
          if (d === '[') {
            depth++;
          } else if (d === ']') {
            depth--;
          }
          j++;
        }
        const atom = seg.slice(i, j).replace(/\{\d+\}$/, '');
        if (atom !== '') {
          tokens.push({ t: 'atom', v: atom });
        }
        i = j;
      }
    }
  }
  return tokens;
}

function parse(tokens) {
  let i = 0;
  const list = (depth) => {
    if (depth > MAX_DEPTH) {
      throw new Error('response nested too deeply');
    }
    const out = [];
    while (i < tokens.length) {
      const tk = tokens[i++];
      if (tk.t === '(') {
        out.push(list(depth + 1));
      } else if (tk.t === ')') {
        return out;
      } else {
        out.push(tk);
      }
    }
    return out;
  };
  return list(0);
}

function text(tk, encoding = 'latin1') {
  if (!tk) {
    return '';
  }
  if (Array.isArray(tk)) {
    return tk.map((x) => text(x, encoding)).join(' ');
  }
  return tk.t === 'lit' ? tk.v.toString(encoding) : String(tk.v);
}

/* Map of FETCH data items keyed by upper-case item name, with .PEEK and
 * partial ranges stripped so BODY.PEEK[...] and BODY[...] look alike.
 */
function fetchItems(tree) {
  const items = tree[2];
  const out = {};
  if (!Array.isArray(items)) {
    return out;
  }
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = text(items[i]).toUpperCase().replace('.PEEK', '').replace(/<\d+>$/, '');
    out[key] = items[i + 1];
  }
  return out;
}

function quote(s) {
  return `"${String(s).replace(/[\0\r\n]/g, ' ').replace(/[\\"]/g, '\\$&')}"`;
}

class ImapClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.sock = null;
    this.reader = new ResponseReader();
    this.tag = 0;
    this.pending = null;
    this.greeting = null;
    this.queue = Promise.resolve();
    this.idling = false;
    this.closed = false;
  }

  connect() {
    const { host, port, user, pass, timeout } = this.opts;
    return new Promise((resolve, reject) => {
      this.greeting = { resolve, reject };
      const sock = tls.connect({ host, port, servername: host });
      this.sock = sock;
      sock.setKeepAlive(true, 30000);
      sock.setTimeout(timeout || 120000, () => this.fail(new ImapError('timeout', 'TIMEOUT'), true));
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (err) => this.fail(err));
      sock.on('close', () => {
        this.closed = true;
        this.fail(new ImapError('connection closed', 'CLOSED'));
        this.emit('close');
      });
    }).then(() => this.command(`LOGIN ${quote(user)} ${quote(pass)}`));
  }

  onData(chunk) {
    this.reader.push(chunk);
    let segments;
    try {
      while ((segments = this.reader.next()) !== null) {
        this.handle(segments);
      }
    } catch (err) {
      this.sock.destroy(err);
      return;
    }
    if (this.reader.pending && this.reader.pending.size > 64 * 1024) {
      this.emit('progress', this.reader.pending);
    }
  }

  handle(segments) {
    const first = segments[0];
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      if (/^\* (OK|PREAUTH)/.test(first)) {
        g.resolve();
      } else {
        g.reject(new ImapError(first, 'GREETING'));
      }
      return;
    }
    if (first.startsWith('+')) {
      if (this.pending && this.pending.onContinue) {
        this.pending.onContinue();
      }
      return;
    }
    if (first.startsWith('* ')) {
      const tree = parse(tokenize(segments)).slice(1);
      if (this.pending) {
        const p = this.pending;
        p.bytes += segments.reduce((n, seg) => n + seg.length, 0);
        if (p.untagged.length >= MAX_UNTAGGED || p.bytes > MAX_COMMAND_BYTES) {
          throw new ImapError('response too large', 'PROTOCOL');
        }
        p.untagged.push(tree);
      }
      this.emit('untagged', tree);
      return;
    }
    const m = /^(A\d+) (OK|NO|BAD)(?: \[([^\]]+)\])? ?(.*)$/.exec(first);
    if (m && this.pending && this.pending.tag === m[1]) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.deadline);
      this.sock.setTimeout(0);
      if (m[2] === 'OK') {
        p.resolve({ untagged: p.untagged, code: m[3] || '', text: m[4] });
      } else {
        p.reject(new ImapError(m[4] || m[2], m[3] || m[2]));
      }
    }
  }

  command(cmd, { onContinue } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new ImapError('connection closed', 'CLOSED'));
        return;
      }
      const tag = `A${++this.tag}`;
      const deadline = setTimeout(() => this.fail(new ImapError('timeout', 'TIMEOUT'), true),
        COMMAND_DEADLINE);
      this.pending = { tag, untagged: [], bytes: 0, resolve, reject, onContinue, deadline };
      /* The inactivity timeout only runs while a reply is awaited. */
      this.sock.setTimeout(this.opts.timeout || 120000);
      this.sock.write(`${tag} ${cmd}${CRLF}`);
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /* Resolves when the server acknowledges DONE. Neither timeout runs
   * while idling, both again once DONE is sent.
   */
  idle() {
    return this.command('IDLE', {
      onContinue: () => {
        this.idling = true;
        clearTimeout(this.pending.deadline);
        this.sock.setTimeout(0);
        this.emit('idle');
      },
    });
  }

  done() {
    if (this.idling && !this.closed) {
      this.idling = false;
      if (this.pending) {
        this.pending.deadline = setTimeout(() => this.fail(new ImapError('timeout', 'TIMEOUT'), true),
          COMMAND_DEADLINE);
      }
      this.sock.setTimeout(this.opts.timeout || 120000);
      this.sock.write(`DONE${CRLF}`);
    }
  }

  fail(err, destroy = false) {
    if (this.greeting) {
      this.greeting.reject(err);
      this.greeting = null;
    }
    if (this.pending) {
      clearTimeout(this.pending.deadline);
      this.pending.reject(err);
      this.pending = null;
    }
    if (destroy) {
      this.close();
    }
  }

  close() {
    this.closed = true;
    if (this.sock) {
      this.sock.destroy();
    }
  }
}

module.exports = { ImapClient, ImapError, fetchItems, text, quote };
