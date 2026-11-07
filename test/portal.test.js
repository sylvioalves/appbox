'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const portal = require('../src/main/portal.js');

const { encode, decode, splitSignature, socketPath, CALL, RETURN, SIGNAL } = portal;

test('signatures split into complete types', () => {
  assert.deepEqual(splitSignature('sa{sv}'), ['s', 'a{sv}']);
  assert.deepEqual(splitSignature('ua{sv}'), ['u', 'a{sv}']);
  assert.deepEqual(splitSignature('a(yv)asb'), ['a(yv)', 'as', 'b']);
  assert.deepEqual(splitSignature(''), []);
  assert.throws(() => splitSignature('a{s'), /bad signature/);
  assert.throws(() => splitSignature('z'), /bad signature/);
});

test('the Hello message has the layout the wire format fixes', () => {
  const buf = encode({
    type: CALL, serial: 1, destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'Hello', body: [],
  });
  assert.equal(buf.length, 128);
  assert.equal(buf[0], 'l'.charCodeAt(0));
  assert.equal(buf[1], CALL);
  assert.equal(buf[3], 1);
  assert.equal(buf.readUInt32LE(4), 0);
  assert.equal(buf.readUInt32LE(8), 1);
  assert.equal(buf.readUInt32LE(12), 109);
  assert.equal(buf[16], 1);
  assert.equal(buf.toString('ascii', 17, 20), '\u0001o\u0000');
  assert.equal(buf.readUInt32LE(20), 21);
  assert.equal(buf.toString('ascii', 24, 45), '/org/freedesktop/DBus');
  assert.equal(buf[48], 2);
  assert.equal(buf.toString('ascii', 56, 76), 'org.freedesktop.DBus');
  assert.equal(buf[80], 3);
  assert.equal(buf.toString('ascii', 88, 93), 'Hello');
  assert.equal(buf[96], 6);
  assert.equal(buf.toString('ascii', 104, 124), 'org.freedesktop.DBus');
});

test('messages survive an encode and decode round trip, also split in chunks', () => {
  const msg = {
    type: SIGNAL, serial: 7, flags: 1, path: '/org/freedesktop/portal/desktop/request/1_5/t',
    interface: 'org.freedesktop.portal.Request', member: 'Response', sender: ':1.9', signature: 'ua{sv}',
    body: [2, { background: { type: 'b', value: true }, autostart: { type: 'b', value: false },
      names: { type: 'as', value: ['a', 'bc'] }, n: { type: 'u', value: 4000000000 }, w: { type: 'y', value: 9 } }],
  };
  const buf = encode(msg);
  assert.equal(decode(buf.subarray(0, 15)), null);
  assert.equal(decode(buf.subarray(0, buf.length - 1)), null);
  const out = decode(Buffer.concat([buf, Buffer.from([1, 2, 3])]));
  assert.equal(out.length, buf.length);
  assert.equal(out.msg.type, SIGNAL);
  assert.equal(out.msg.serial, 7);
  assert.equal(out.msg.path, msg.path);
  assert.equal(out.msg.member, 'Response');
  assert.equal(out.msg.sender, ':1.9');
  assert.equal(out.msg.signature, 'ua{sv}');
  assert.deepEqual(out.msg.body, [2, { background: true, autostart: false, names: ['a', 'bc'], n: 4000000000, w: 9 }]);
});

test('a big endian message decodes too', () => {
  const buf = encode({ type: RETURN, serial: 3, replySerial: 2, signature: 's', body: ['hi'] });
  const be = Buffer.from(buf);
  be[0] = 'B'.charCodeAt(0);
  be.writeUInt32BE(buf.readUInt32LE(4), 4);
  be.writeUInt32BE(buf.readUInt32LE(8), 8);
  be.writeUInt32BE(buf.readUInt32LE(12), 12);
  /* reply serial field value at 20, body string length at the body start */
  be.writeUInt32BE(buf.readUInt32LE(20), 20);
  const bodyAt = buf.length - 7;
  be.writeUInt32BE(buf.readUInt32LE(bodyAt), bodyAt);
  const out = decode(be);
  assert.equal(out.msg.replySerial, 2);
  assert.deepEqual(out.msg.body, ['hi']);
});

test('the socket path comes from the unix entry of the address', () => {
  assert.equal(socketPath('unix:path=/run/user/1000/bus'), '/run/user/1000/bus');
  assert.equal(socketPath('tcp:host=x,port=1;unix:path=/run/flatpak/bus,guid=ab'), '/run/flatpak/bus');
  assert.equal(socketPath('unix:abstract=/tmp/dbus-X'), '\0/tmp/dbus-X');
  assert.equal(socketPath('unix:path=/a%20b'), '/a b');
  assert.throws(() => socketPath(''), /no unix session bus address/);
  assert.throws(() => socketPath(undefined), /no unix session bus address/);
});

/* A bus that answers Hello and plays the Background portal: it checks
 * the request, replies with the handle and then sends the Response
 * signal with the autostart answer given.
 */
function fakeBus(file, answer) {
  const seen = [];
  const server = net.createServer((socket) => {
    let text = '';
    let ready = false;
    let buf = Buffer.alloc(0);
    let serial = 100;
    const send = (msg) => socket.write(encode({ ...msg, serial: (serial += 1) }));
    socket.on('data', (chunk) => {
      if (!ready) {
        text += chunk.toString('latin1');
        if (text.startsWith('\0AUTH EXTERNAL ') && text.includes('\r\n') && !text.includes('BEGIN\r\n')) {
          socket.write('OK 0123456789abcdef0123456789abcdef\r\n');
          return;
        }
        if (text.includes('BEGIN\r\n')) {
          ready = true;
          chunk = Buffer.from(text.slice(text.indexOf('BEGIN\r\n') + 7), 'latin1');
          text = '';
        } else {
          return;
        }
      }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const out = decode(buf);
        if (!out) {
          return;
        }
        buf = buf.subarray(out.length);
        const m = out.msg;
        seen.push(m);
        if (m.member === 'Hello') {
          send({ type: RETURN, replySerial: m.serial, sender: 'org.freedesktop.DBus', destination: ':1.5', signature: 's', body: [':1.5'] });
        } else if (m.member === 'RequestBackground') {
          const token = m.body[1].handle_token;
          const handle = `/org/freedesktop/portal/desktop/request/1_5/${token}`;
          if (answer === 'error') {
            send({ type: portal.ERROR, replySerial: m.serial, errorName: 'org.freedesktop.DBus.Error.ServiceUnknown', signature: 's', body: ['no portal'] });
            return;
          }
          if (answer === 'early') {
            send({ type: SIGNAL, path: handle, interface: 'org.freedesktop.portal.Request', member: 'Response', signature: 'ua{sv}',
              body: [0, { background: { type: 'b', value: true }, autostart: { type: 'b', value: true } }] });
          }
          send({ type: RETURN, replySerial: m.serial, signature: 'o', body: [handle] });
          if (answer !== 'early') {
            send({ type: SIGNAL, path: handle, interface: 'org.freedesktop.portal.Request', member: 'Response', signature: 'ua{sv}',
              body: [answer ? 0 : 1, { background: { type: 'b', value: Boolean(answer) }, autostart: { type: 'b', value: Boolean(answer) } }] });
          }
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(file, () => resolve({ server, seen })));
}

test('requestBackground talks to the portal and reports its answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-bus-'));
  const file = path.join(dir, 'bus');
  const address = `unix:path=${file}`;
  try {
    for (const [answer, expected] of [[true, { response: 0, background: true, autostart: true }],
      [false, { response: 1, background: false, autostart: false }],
      ['early', { response: 0, background: true, autostart: true }]]) {
      const { server, seen } = await fakeBus(file, answer);
      const out = await portal.requestBackground({ autostart: true, commandline: ['appbox', '--hidden'], reason: 'Start at login' }, address);
      assert.deepEqual(out, expected);
      const req = seen.find((m) => m.member === 'RequestBackground');
      assert.equal(req.destination, 'org.freedesktop.portal.Desktop');
      assert.equal(req.path, '/org/freedesktop/portal/desktop');
      assert.equal(req.interface, 'org.freedesktop.portal.Background');
      assert.equal(req.body[0], '');
      assert.equal(req.body[1].autostart, true);
      assert.equal(req.body[1].reason, 'Start at login');
      assert.deepEqual(req.body[1].commandline, ['appbox', '--hidden']);
      assert.match(req.body[1].handle_token, /^[A-Za-z0-9_]+$/);
      server.close();
      fs.rmSync(file, { force: true });
    }
    const { server } = await fakeBus(file, 'error');
    await assert.rejects(portal.requestBackground({ autostart: false, commandline: ['appbox'] }, address), /ServiceUnknown: no portal/);
    server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the session bus of this machine answers GetId', { skip: !process.env.DBUS_SESSION_BUS_ADDRESS }, async () => {
  const bus = await portal.Bus.connect();
  try {
    assert.match(bus.name, /^:/);
    const [id] = await bus.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetId',
    });
    assert.match(id, /^[0-9a-f]{32}$/);
    const [has] = await bus.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
      member: 'NameHasOwner', signature: 's', body: ['org.freedesktop.DBus'],
    });
    assert.equal(has, true);
  } finally {
    bus.close();
  }
});
