'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mime = require('../src/mail/mime.js');

const CRLF = '\r\n';

function multipart(type, boundary, parts) {
  const body = parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join('');
  return `Content-Type: ${type}; boundary="${boundary}"${CRLF}${CRLF}${body}--${boundary}--${CRLF}`;
}

function textPart(body) {
  return `Content-Type: text/plain; charset=utf-8${CRLF}${CRLF}${body}`;
}

test('parseHeaders folds continuations and keeps every occurrence', () => {
  const h = mime.parseHeaders(['Subject: one', ' two', 'X-A: first', 'X-A: last', 'Bad line'].join(CRLF));
  assert.equal(h.get('subject'), 'one two');
  assert.equal(h.get('x-a'), 'last');
  assert.equal(h.first('x-a'), 'first');
  assert.equal(h.get('missing'), '');
  assert.equal(h.list.length, 3);
});

test('parseHeaders caps the value length and the header count', () => {
  const long = 'x'.repeat(20000);
  const h = mime.parseHeaders(`A: ${long}${CRLF}B: y${CRLF} ${long}`);
  assert.equal(h.get('a').length, 8192);
  assert.equal(h.get('b').length, 8192);

  const many = Array.from({ length: 1500 }, (_, i) => `H${i}: v`).join(CRLF);
  assert.equal(mime.parseHeaders(many).list.length, 1000);
});

test('decodeWords handles B and Q words and drops bidi controls', () => {
  const b = Buffer.from('caf\u00e9', 'utf8').toString('base64');
  assert.equal(mime.decodeWords(`=?utf-8?B?${b}?=`), 'caf\u00e9');
  assert.equal(mime.decodeWords('=?iso-8859-1?Q?caf=E9_au_lait?='), 'caf\u00e9 au lait');
  assert.equal(mime.decodeWords('=?utf-8?Q?a?= =?utf-8?Q?b?='), 'ab');
  assert.equal(mime.decodeWords('fine\u202ereversed\u202c'), 'finereversed');
  assert.equal(mime.decodeWords(''), '');
});

test('decodeCharset and decodeTransfer', () => {
  assert.equal(mime.decodeCharset(Buffer.from([0xe9]), 'iso-8859-1'), '\u00e9');
  assert.equal(mime.decodeCharset(Buffer.from('ok'), 'no-such-charset'), 'ok');
  assert.equal(mime.decodeTransfer(Buffer.from('aGVs bG8=\r\n'), 'BASE64').toString(), 'hello');
  assert.equal(mime.decodeTransfer(Buffer.from('a=3Db=\r\nc'), 'quoted-printable').toString(), 'a=bc');
  assert.equal(mime.decodeTransfer(Buffer.from('raw'), '7bit').toString(), 'raw');
});

test('parseAddresses takes the address from the angle group, not a quoted name', () => {
  const spoof = mime.parseAddresses('"<friend@gmail.com>" <attacker@gmail.com>');
  assert.deepEqual(spoof, [{ name: '<friend@gmail.com>', email: 'attacker@gmail.com' }]);
  assert.deepEqual(mime.parseAddresses('"Doe, Jane" <jane@example.com>, bob@example.org (Bob)'), [
    { name: 'Doe, Jane', email: 'jane@example.com' },
    { name: '', email: 'bob@example.org' },
  ]);
  assert.deepEqual(mime.parseAddresses('<a@x.com> <b@y.com>'), []);
  assert.deepEqual(mime.parseAddresses('<bad\u0001@x.com>, nobody, <a b@x.com>'), []);
  assert.deepEqual(mime.parseAddresses(''), []);
});

test('parseMessage picks text and html from alternatives and decodes attachments', () => {
  const html = `Content-Type: text/html; charset=utf-8${CRLF}${CRLF}<p>hi</p>`;
  const alt = multipart('multipart/alternative', 'alt', [textPart('hi'), html]);
  const file = [
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=UTF-8''caf%C3%A9.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF').toString('base64'),
  ].join(CRLF);
  const img = [
    'Content-Type: image/png; name="pic.png"',
    'Content-ID: <pic1>',
    '',
    'png',
  ].join(CRLF);
  const msg = [
    'From: "Jane" <jane@example.com>',
    'To: bob@example.org',
    'Subject: =?utf-8?Q?caf=C3=A9?=',
    'Message-ID: <m1@example.com>',
    'Authentication-Results: mx; spf=pass',
    'Authentication-Results: other',
    `${multipart('multipart/mixed', 'mix', [alt, file, img])}`,
  ].join(CRLF);
  const r = mime.parseMessage(Buffer.from(msg));
  assert.equal(r.subject, 'caf\u00e9');
  assert.equal(r.from[0].email, 'jane@example.com');
  assert.equal(r.to[0].email, 'bob@example.org');
  assert.equal(r.messageId, '<m1@example.com>');
  assert.equal(r.authResults, 'mx; spf=pass');
  assert.equal(r.text, 'hi');
  assert.equal(r.html, '<p>hi</p>');
  assert.equal(r.truncated, false);
  assert.equal(r.attachments.length, 2);
  assert.equal(r.attachments[0].filename, 'caf\u00e9.pdf');
  assert.equal(r.attachments[0].content.toString(), '%PDF');
  assert.equal(r.attachments[0].inline, false);
  assert.equal(r.attachments[1].filename, 'pic.png');
  assert.equal(r.attachments[1].cid, 'pic1');
  assert.equal(r.attachments[1].inline, true);
});

test('parseMessage caps the number of parts across nested multiparts', () => {
  const inner = (n) => multipart('multipart/mixed', `in${n}`,
    Array.from({ length: 300 }, (_, i) => textPart(`p${n}-${i}`)));
  const msg = `Subject: deep${CRLF}${multipart('multipart/mixed', 'out', [inner(1), inner(2), inner(3)])}`;
  const r = mime.parseMessage(Buffer.from(msg));
  assert.equal(r.text.split('\n\n').length, 497);
});

test('parseMessage stops descending below ten multipart levels', () => {
  let part = textPart('leaf');
  for (let i = 0; i <= 10; i++) {
    part = multipart('multipart/mixed', `b${i}`, [part]);
  }
  const r = mime.parseMessage(Buffer.from(`Subject: nest${CRLF}${part}`));
  assert.equal(r.text, '');
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0].type, 'multipart/mixed');
});

test('parseMessage truncates text bodies past the budget', () => {
  const body = 'a'.repeat(5 * 1024 * 1024);
  const r = mime.parseMessage(Buffer.from(`${textPart(body)}`));
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 4 * 1024 * 1024);
});

test('parseEnvelope reads the headers only', () => {
  const r = mime.parseEnvelope(Buffer.from(`From: a@x.com${CRLF}Date: today${CRLF}${CRLF}body`));
  assert.equal(r.from[0].email, 'a@x.com');
  assert.equal(r.date, 'today');
  assert.equal(r.text, undefined);
});
