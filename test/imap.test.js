'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ImapClient, ImapError, fetchItems, text, quote } = require('../src/mail/imap.js');

/* The reader is reached through a client that never connects. */
function reader() {
  return new ImapClient({ host: 'imap.example.com', port: 993 }).reader;
}

function untagged(data) {
  const client = new ImapClient({ host: 'imap.example.com', port: 993 });
  const trees = [];
  client.on('untagged', (tree) => trees.push(tree));
  client.onData(Buffer.from(data, 'latin1'));
  return trees;
}

test('ResponseReader yields one line per response and waits for the rest', () => {
  const r = reader();
  r.push(Buffer.from('* OK ready\r\nA1 OK done\r\nA2 N'));
  assert.deepEqual(r.next(), ['* OK ready']);
  assert.deepEqual(r.next(), ['A1 OK done']);
  assert.equal(r.next(), null);
  r.push(Buffer.from('O no\r\n'));
  assert.deepEqual(r.next(), ['A2 NO no']);
  assert.equal(r.next(), null);
});

test('ResponseReader joins a literal split across chunks', () => {
  const r = reader();
  r.push(Buffer.from('* 1 FETCH (BODY[] {11}\r\nhello'));
  assert.equal(r.next(), null);
  assert.equal(r.pending.size, 11);
  assert.equal(r.pending.have, 5);
  r.push(Buffer.from(' world)\r\n'));
  const segs = r.next();
  assert.equal(segs.length, 3);
  assert.equal(segs[0], '* 1 FETCH (BODY[] {11}');
  assert.equal(segs[1].toString(), 'hello world');
  assert.equal(segs[2], ')');
  assert.equal(r.pending, null);
});

test('ResponseReader rejects an oversized literal', () => {
  const r = reader();
  r.push(Buffer.from('* 1 FETCH (BODY[] {104857601}\r\n'));
  assert.throws(() => r.next(), (err) => err instanceof ImapError && err.code === 'PROTOCOL'
    && err.message === 'literal too large');
});

test('ResponseReader rejects a line past the cap', () => {
  const r = reader();
  r.push(Buffer.alloc(1024 * 1024 + 1, 0x41));
  assert.throws(() => r.next(), (err) => err instanceof ImapError && err.code === 'PROTOCOL'
    && err.message === 'line too long');
});

test('ResponseReader accepts a line of exactly the cap once it ends', () => {
  const r = reader();
  r.push(Buffer.alloc(1024 * 1024, 0x41));
  assert.equal(r.next(), null);
  r.push(Buffer.from('\r\n'));
  assert.equal(r.next()[0].length, 1024 * 1024);
});

test('untagged FETCH responses parse into nested lists and literals', () => {
  const [tree] = untagged('* 12 FETCH (UID 99 FLAGS (\\Seen \\Flagged) BODY.PEEK[HEADER]<0> {5}\r\nhello)\r\n');
  assert.equal(text(tree[0]), '12');
  assert.equal(text(tree[1]), 'FETCH');
  const items = fetchItems(tree);
  assert.equal(text(items.UID), '99');
  assert.equal(text(items.FLAGS), '\\Seen \\Flagged');
  assert.equal(text(items['BODY[HEADER]']), 'hello');
  assert.equal(items['BODY.PEEK[HEADER]<0>'], undefined);
});

test('quoted strings keep spaces and escapes', () => {
  const [tree] = untagged('* LIST (\\HasNoChildren) "/" "Sent \\"Mail\\""\r\n');
  assert.equal(text(tree[1]), '\\HasNoChildren');
  assert.equal(text(tree[2]), '/');
  assert.equal(text(tree[3]), 'Sent "Mail"');
});

test('fetchItems ignores responses without an item list', () => {
  assert.deepEqual(fetchItems([{ t: 'atom', v: '3' }, { t: 'atom', v: 'EXISTS' }]), {});
});

test('text joins lists and decodes literals', () => {
  assert.equal(text(undefined), '');
  assert.equal(text({ t: 'lit', v: Buffer.from('caf\u00e9', 'utf8') }, 'utf8'), 'caf\u00e9');
  assert.equal(text([{ t: 'atom', v: 'a' }, [{ t: 'str', v: 'b' }]]), 'a b');
});

test('quote escapes quotes and backslashes and strips line breaks', () => {
  assert.equal(quote('plain'), '"plain"');
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(quote('x\r\ny\0z'), '"x  y z"');
});

test('ImapError carries a code', () => {
  assert.equal(new ImapError('m').code, 'IMAP');
  assert.equal(new ImapError('m', 'TIMEOUT').code, 'TIMEOUT');
});
