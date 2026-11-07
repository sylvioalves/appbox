'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMessage, parseAddresses, quotedPrintable } = require('../src/mail/compose.js');

test('parseAddresses splits on commas and semicolons and validates each one', () => {
  assert.deepEqual(parseAddresses('Jane Doe <jane@example.com>, bob@example.org; "Q" <q@example.net>'), [
    { name: 'Jane Doe', email: 'jane@example.com' },
    { name: '', email: 'bob@example.org' },
    { name: 'Q', email: 'q@example.net' },
  ]);
  assert.deepEqual(parseAddresses('<bob@example.org>'), [{ name: '', email: 'bob@example.org' }]);
  assert.deepEqual(parseAddresses('Name <a@b.c>'), [{ name: 'Name', email: 'a@b.c' }]);
  assert.deepEqual(parseAddresses(''), []);
  assert.throws(() => parseAddresses('nobody'), /invalid address/);
  assert.throws(() => parseAddresses('a@b'), /invalid address/);
  assert.throws(() => parseAddresses('"X" <a@b.c\r\nBcc: x@y.z>'), /invalid address/);
});

test('quotedPrintable encodes what RFC 2045 requires and wraps at 76', () => {
  assert.equal(quotedPrintable('plain text'), 'plain text');
  assert.equal(quotedPrintable('a=b'), 'a=3Db');
  assert.equal(quotedPrintable('caf\u00e9'), 'caf=C3=A9');
  assert.equal(quotedPrintable('one \ntwo'), 'one=20\r\ntwo');
  const long = quotedPrintable('x'.repeat(200));
  for (const line of long.split('\r\n')) {
    assert.ok(line.length <= 76);
  }
  assert.equal(long.replace(/=\r\n/g, ''), 'x'.repeat(200));
});

test('buildMessage writes the headers and keeps Bcc out of them', () => {
  const m = buildMessage({
    from: 'me@example.com',
    fromName: 'Me',
    to: 'a@example.com',
    cc: 'b@example.com, a@example.com',
    bcc: 'c@example.com',
    subject: 'Hello',
    text: 'body',
  });
  assert.deepEqual(m.rcpts, ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.match(m.messageId, /^<[0-9a-z]+\.[0-9a-f]{16}@example\.com>$/);
  assert.match(m.data, /^From: Me <me@example\.com>\r\n/);
  assert.match(m.data, /\r\nTo: a@example\.com\r\n/);
  assert.match(m.data, /\r\nCc: b@example\.com, a@example\.com\r\n/);
  assert.doesNotMatch(m.data, /Bcc/);
  assert.match(m.data, /\r\nMessage-ID: <[^>]+>\r\n/);
  assert.match(m.data, /\r\n\r\nbody$/);
  assert.doesNotMatch(m.data, /multipart/);
});

test('buildMessage encodes header values that could break out of their line', () => {
  const m = buildMessage({ from: 'me@example.com', to: 'a@example.com', subject: 'Hi\r\nBcc: x@y.z', text: '' });
  assert.doesNotMatch(m.data, /Bcc/);
  assert.match(m.data, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  const n = buildMessage({
    from: 'me@example.com',
    to: 'a@example.com',
    inReplyTo: 'junk <id1@x> more\r\nBcc: y@z',
    references: '<r1@x> <r2@x>',
    text: '',
  });
  assert.match(n.data, /\r\nIn-Reply-To: <id1@x>\r\n/);
  assert.match(n.data, /\r\nReferences: <r1@x> <r2@x>\r\n/);
});

test('buildMessage refuses an empty recipient list unless told otherwise', () => {
  assert.throws(() => buildMessage({ from: 'me@example.com', text: 'x' }), /no recipients/);
  const m = buildMessage({ from: 'me@example.com', text: 'x', allowEmpty: true });
  assert.deepEqual(m.rcpts, []);
});

test('buildMessage nests html and attachments in multiparts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-compose-'));
  try {
    const file = path.join(dir, 'caf\u00e9 "1".txt');
    fs.writeFileSync(file, 'attached');
    const m = buildMessage({
      from: 'me@example.com',
      to: 'a@example.com',
      text: 'plain',
      html: '<b>rich</b>',
      attachments: [{ path: file }, { path: file, name: 'plain.txt', type: 'text/plain' }],
    });
    assert.match(m.data, /Content-Type: multipart\/mixed; boundary="=_appbox_[0-9a-f]{24}"/);
    assert.match(m.data, /Content-Type: multipart\/alternative; boundary="=_alt_[0-9a-f]{24}"/);
    assert.match(m.data, /Content-Type: text\/plain; charset=UTF-8\r\n[^]*?\r\n\r\nplain\r\n/);
    assert.match(m.data, /Content-Type: text\/html; charset=UTF-8\r\n[^]*?\r\n\r\n<b>rich<\/b>\r\n/);
    assert.match(m.data, /Content-Type: application\/octet-stream; name\*=UTF-8''caf%C3%A9%20%221%22\.txt\r\n/);
    assert.match(m.data, /Content-Disposition: attachment; filename="plain\.txt"\r\n/);
    assert.equal((m.data.match(/YXR0YWNoZWQ=/g) || []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
