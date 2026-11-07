'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TOTAL = 25 * 1024 * 1024;

function encodeWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/* "Name <addr>" or bare addresses, split on commas and semicolons. */
function parseAddresses(input) {
  const out = [];
  for (const raw of String(input || '').split(/[,;]/)) {
    const s = raw.trim();
    if (!s) {
      continue;
    }
    const m = s.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
    const email = (m ? m[2] : s).trim();
    const name = m && m[1] ? m[1].trim() : '';
    if (!/^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]+$/.test(email)) {
      throw new Error(`invalid address: ${s}`);
    }
    out.push({ name, email });
  }
  return out;
}

/* Keeps only the <message-id> tokens of an In-Reply-To or References value. */
function messageIds(s) {
  return (String(s || '').match(/<[^<>\s]+>/g) || []).join(' ');
}

function formatAddress(a) {
  return a.name ? `${encodeWord(a.name)} <${a.email}>` : a.email;
}

function quotedPrintable(text) {
  const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
  let out = '';
  let line = '';
  const flush = (soft) => {
    out += `${line}${soft ? '=' : ''}\r\n`;
    line = '';
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      if (/[ \t]$/.test(line)) {
        line = `${line.slice(0, -1)}=${line.charCodeAt(line.length - 1).toString(16).toUpperCase().padStart(2, '0')}`;
      }
      flush(false);
      i += 1;
      continue;
    }
    const printable = (b >= 0x20 && b <= 0x7e && b !== 0x3d) || b === 0x09;
    const piece = printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line.length + piece.length > 75) {
      flush(true);
    }
    line += piece;
  }
  if (line) {
    out += line;
  }
  return out;
}

function base64Lines(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/* Builds the RFC 5322 message text and the envelope recipients. */
function buildMessage(opts) {
  const to = parseAddresses(opts.to);
  const cc = parseAddresses(opts.cc);
  const bcc = parseAddresses(opts.bcc);
  if (to.length + cc.length + bcc.length === 0 && !opts.allowEmpty) {
    throw new Error('no recipients');
  }
  const domain = String(opts.from).split('@')[1] || 'appbox';
  const messageId = `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;
  const headers = [
    `From: ${formatAddress({ name: opts.fromName || '', email: opts.from })}`,
    to.length ? `To: ${to.map(formatAddress).join(', ')}` : null,
    cc.length ? `Cc: ${cc.map(formatAddress).join(', ')}` : null,
    `Subject: ${encodeWord(String(opts.subject || ''))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    messageIds(opts.inReplyTo) ? `In-Reply-To: ${messageIds(opts.inReplyTo)}` : null,
    messageIds(opts.references) ? `References: ${messageIds(opts.references)}` : null,
    'MIME-Version: 1.0',
    'X-Mailer: Appbox',
  ].filter(Boolean);

  const plainPart = 'Content-Type: text/plain; charset=UTF-8\r\n'
    + 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
    + quotedPrintable(String(opts.text || ''));
  let textPart = plainPart;
  if (opts.html) {
    const alt = `=_alt_${crypto.randomBytes(12).toString('hex')}`;
    const htmlPart = 'Content-Type: text/html; charset=UTF-8\r\n'
      + 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
      + quotedPrintable(String(opts.html));
    textPart = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n`
      + `--${alt}\r\n${plainPart}\r\n--${alt}\r\n${htmlPart}\r\n--${alt}--\r\n`;
  }

  const files = (opts.attachments || []).map((a) => {
    const buf = fs.readFileSync(a.path);
    return { name: a.name || path.basename(a.path), type: a.type || 'application/octet-stream', buf };
  });
  const total = files.reduce((n, f) => n + f.buf.length, 0);
  if (total > MAX_TOTAL) {
    throw new Error('attachments exceed 25 MB');
  }

  let data;
  if (files.length === 0) {
    data = `${headers.join('\r\n')}\r\n${textPart}`;
  } else {
    const boundary = `=_appbox_${crypto.randomBytes(12).toString('hex')}`;
    const parts = [textPart];
    for (const f of files) {
      const ascii = /^[\x20-\x7e]*$/.test(f.name) && !/["\\]/.test(f.name);
      const nameParam = ascii ? `name="${f.name}"` : `name*=UTF-8''${encodeURIComponent(f.name)}`;
      const fileParam = ascii ? `filename="${f.name}"` : `filename*=UTF-8''${encodeURIComponent(f.name)}`;
      parts.push(`Content-Type: ${f.type}; ${nameParam}\r\n`
        + `Content-Disposition: attachment; ${fileParam}\r\n`
        + 'Content-Transfer-Encoding: base64\r\n\r\n'
        + base64Lines(f.buf));
    }
    data = `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`
      + parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')
      + `--${boundary}--\r\n`;
  }
  const rcpts = [...to, ...cc, ...bcc].map((a) => a.email);
  return { data, rcpts: [...new Set(rcpts)], messageId };
}

module.exports = { buildMessage, parseAddresses, quotedPrintable };
