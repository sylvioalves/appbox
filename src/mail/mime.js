'use strict';

const HEADER_MAX = 8 * 1024;
const HEADERS_MAX = 1000;
const PARTS_MAX = 500;
/* Bytes of text and html bodies kept per message. */
const TEXT_MAX = 4 * 1024 * 1024;

function decodeCharset(buf, charset) {
  const label = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label === 'us-ascii' ? 'utf-8' : label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function decodeQp(str, underscoreIsSpace = false) {
  let s = str.replace(/=\r?\n/g, '');
  if (underscoreIsSpace) {
    s = s.replace(/_/g, ' ');
  }
  const bytes = Buffer.allocUnsafe(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes[n++] = parseInt(s.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      bytes[n++] = s.charCodeAt(i) & 0xff;
    }
  }
  return bytes.subarray(0, n);
}

function decodeTransfer(buf, cte) {
  const enc = String(cte || '').trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    return decodeQp(buf.toString('latin1'));
  }
  return buf;
}

const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/* RFC 2047 encoded words in header values. Bidirectional controls are
 * dropped so a name cannot display reversed.
 */
function decodeWords(value) {
  if (!value) {
    return '';
  }
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
      const bytes = enc.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : decodeQp(data, true);
      return decodeCharset(bytes, charset);
    })
    .replace(BIDI_RE, '');
}

function parseHeaders(text) {
  const headers = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) {
      if (cur.value.length < HEADER_MAX) {
        cur.value += ` ${line.trim()}`.slice(0, HEADER_MAX - cur.value.length);
      }
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (m && headers.length < HEADERS_MAX) {
      cur = { name: m[1].toLowerCase(), value: m[2].slice(0, HEADER_MAX) };
      headers.push(cur);
    }
  }
  const get = (name) => {
    const h = headers.filter((x) => x.name === name);
    return h.length > 0 ? h[h.length - 1].value : '';
  };
  const first = (name) => {
    const h = headers.find((x) => x.name === name);
    return h ? h.value : '';
  };
  return { list: headers, get, first };
}

/* "type/subtype; a=b; c="d"" into { value, params }, with basic RFC 2231
 * continuation and charset handling for file names.
 */
function parseParams(header) {
  const parts = [];
  let cur = '';
  let quoted = false;
  for (const ch of header || '') {
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    } else if (ch === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const value = parts.shift().trim();
  const raw = Object.create(null);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (k === '') {
      continue;
    }
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    raw[k] = v;
  }
  const params = Object.create(null);
  const cont = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(k);
    if (!m) {
      continue;
    }
    const base = m[1];
    const idx = m[2] === undefined ? -1 : Number(m[2]);
    const ext = Boolean(m[3]);
    cont[base] = cont[base] || [];
    cont[base].push({ idx, ext, v });
  }
  for (const [base, pieces] of Object.entries(cont)) {
    pieces.sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    let out = '';
    pieces.forEach((p, i) => {
      let v = p.v;
      if (p.ext) {
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (m) {
            charset = m[1] || 'utf-8';
            v = m[2];
          }
        }
        const bytes = [];
        for (let j = 0; j < v.length; j++) {
          if (v[j] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(j + 1, j + 3))) {
            bytes.push(parseInt(v.slice(j + 1, j + 3), 16));
            j += 2;
          } else {
            bytes.push(v.charCodeAt(j) & 0xff);
          }
        }
        v = decodeCharset(Buffer.from(bytes), charset);
      }
      out += v;
    });
    params[base] = out;
  }
  return { value, params };
}

/* Splits an address list on commas outside quotes, comments and angle
 * brackets.
 */
function splitAddressList(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  let comment = 0;
  let angle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && (quoted || comment > 0)) {
      cur += s.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (quoted) {
      quoted = ch !== '"';
    } else if (comment > 0) {
      comment += ch === '(' ? 1 : (ch === ')' ? -1 : 0);
    } else if (ch === '"' && !angle) {
      quoted = true;
    } else if (ch === '(') {
      comment = 1;
    } else if (ch === '<') {
      angle = true;
    } else if (ch === '>') {
      angle = false;
    } else if (!angle && ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* One list item as its display text and the addr-spec of its angle
 * group. Quoted strings and comments never open a group, and an item
 * with several groups yields no address.
 */
function splitAddressItem(item) {
  let name = '';
  let email = null;
  let groups = 0;
  let cur = '';
  let quoted = false;
  let comment = 0;
  let angle = false;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    if (ch === '\\' && (quoted || comment > 0)) {
      i += 1;
      if (quoted && i < item.length) {
        cur += item[i];
      }
      continue;
    }
    if (quoted) {
      if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (comment > 0) {
      comment += ch === '(' ? 1 : (ch === ')' ? -1 : 0);
    } else if (ch === '"' && !angle) {
      quoted = true;
    } else if (ch === '(') {
      comment = 1;
    } else if (ch === '<' && !angle) {
      angle = true;
      name += cur;
      cur = '';
    } else if (ch === '>' && angle) {
      angle = false;
      email = cur;
      cur = '';
      groups += 1;
    } else {
      cur += ch;
    }
  }
  if (angle) {
    email = cur;
    groups += 1;
  } else {
    name += cur;
  }
  return { name, email: groups === 1 ? email : null, groups };
}

const ADDR_BAD_RE = /[\s<>"(),;:\\\x00-\x1f\x7f]/;

function parseAddresses(value) {
  const out = [];
  for (const item of splitAddressList(value || '')) {
    const { name, email, groups } = splitAddressItem(item);
    const addr = (groups === 0 ? name : email || '').trim();
    if (addr === '' || !addr.includes('@') || ADDR_BAD_RE.test(addr)) {
      continue;
    }
    out.push({ name: groups === 0 ? '' : decodeWords(name.trim()).trim(), email: addr });
  }
  return out;
}

function splitHeaderBody(buf) {
  let idx = buf.indexOf('\r\n\r\n');
  let sep = 4;
  if (idx === -1) {
    idx = buf.indexOf('\n\n');
    sep = 2;
  }
  if (idx === -1) {
    return [buf.toString('latin1'), Buffer.alloc(0)];
  }
  return [buf.toString('latin1', 0, idx), buf.subarray(idx + sep)];
}

function splitMultipart(body, boundary, budget) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  let pos = body.indexOf(delim);
  while (pos !== -1 && budget.parts > 0) {
    const lineEnd = body.indexOf('\n', pos);
    if (lineEnd === -1) {
      break;
    }
    const marker = body.toString('latin1', pos, lineEnd);
    if (marker.startsWith(`--${boundary}--`)) {
      break;
    }
    const start = lineEnd + 1;
    const next = body.indexOf(delim, start);
    if (next === -1) {
      break;
    }
    let end = next;
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) {
      end -= 2;
    } else if (end >= 1 && body[end - 1] === 0x0a) {
      end -= 1;
    }
    parts.push(body.subarray(start, end));
    budget.parts -= 1;
    pos = next;
  }
  return parts;
}

function parsePart(buf, depth, budget) {
  const [headerText, body] = splitHeaderBody(buf);
  const headers = parseHeaders(headerText);
  const ct = parseParams(headers.get('content-type') || 'text/plain');
  const type = ct.value.toLowerCase() || 'text/plain';
  const result = { headers, text: '', html: '', attachments: [], truncated: false };

  if (type.startsWith('multipart/') && ct.params.boundary && depth < 10) {
    const subs = splitMultipart(body, ct.params.boundary, budget)
      .map((p) => parsePart(p, depth + 1, budget));
    if (type === 'multipart/alternative') {
      for (const s of subs) {
        if (s.html && !result.html) {
          result.html = s.html;
        }
        if (s.text && !result.text) {
          result.text = s.text;
        }
        result.attachments.push(...s.attachments);
        result.truncated = result.truncated || s.truncated;
      }
    } else {
      for (const s of subs) {
        if (s.html) {
          result.html = result.html ? `${result.html}<hr>${s.html}` : s.html;
        }
        if (s.text) {
          result.text = result.text ? `${result.text}\n\n${s.text}` : s.text;
        }
        result.attachments.push(...s.attachments);
        result.truncated = result.truncated || s.truncated;
      }
    }
    return result;
  }

  const data = decodeTransfer(body, headers.get('content-transfer-encoding'));
  const disp = parseParams(headers.get('content-disposition'));
  const disposition = disp.value.toLowerCase();
  const filename = decodeWords(disp.params.filename || ct.params.name || '');
  const cid = (headers.get('content-id') || '').trim().replace(/^<|>$/g, '');
  const isText = type === 'text/plain' || type === 'text/html';

  if (isText && disposition !== 'attachment') {
    const kept = data.length > budget.text ? data.subarray(0, budget.text) : data;
    budget.text -= kept.length;
    result.truncated = kept.length < data.length;
    const decoded = decodeCharset(kept, ct.params.charset);
    if (type === 'text/html') {
      result.html = decoded;
    } else {
      result.text = decoded;
    }
    return result;
  }
  result.attachments.push({
    filename: filename || (type === 'message/rfc822' ? 'message.eml' : 'attachment'),
    type,
    size: data.length,
    cid,
    inline: disposition === 'inline' || cid !== '',
    content: data,
  });
  return result;
}

function envelope(h) {
  return {
    subject: decodeWords(h.get('subject')),
    from: parseAddresses(h.get('from')),
    authResults: h.first('authentication-results') || '',
    to: parseAddresses(h.get('to')),
    cc: parseAddresses(h.get('cc')),
    date: h.get('date'),
    messageId: h.get('message-id'),
  };
}

function parseMessage(buf) {
  const part = parsePart(buf, 0, { parts: PARTS_MAX, text: TEXT_MAX });
  return {
    ...envelope(part.headers),
    text: part.text,
    html: part.html,
    attachments: part.attachments,
    truncated: part.truncated,
  };
}

/* Header fields only, for a message whose body is not parsed. */
function parseEnvelope(buf) {
  const [headerText] = splitHeaderBody(buf.subarray(0, HEADERS_MAX * HEADER_MAX));
  return envelope(parseHeaders(headerText));
}

module.exports = {
  parseMessage, parseEnvelope, parseHeaders, parseAddresses, decodeWords, decodeCharset, decodeTransfer,
};
