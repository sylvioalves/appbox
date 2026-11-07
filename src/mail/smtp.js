'use strict';

const tls = require('tls');

const CRLF = '\r\n';
const MAX_REPLY = 64 * 1024;
const DEADLINE = 20 * 60 * 1000;

class SmtpError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/* Minimal submission client: implicit TLS, AUTH PLAIN, one message. */
function sendMail({ host, port, user, pass, from, rcpts, data, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host });
    let buf = '';
    let waiter = null;
    let done = false;

    const finish = (err) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(deadline);
      sock.destroy();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    /* Resolves with [code, text] once a complete reply has arrived. */
    const reply = () => new Promise((res, rej) => {
      waiter = { res, rej };
      pump();
    });
    const pump = () => {
      if (!waiter) {
        return;
      }
      const lines = buf.split(CRLF);
      const last = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (last === -1) {
        return;
      }
      const chunk = lines.slice(0, last + 1);
      buf = lines.slice(last + 1).join(CRLF);
      const w = waiter;
      waiter = null;
      w.res([Number(chunk[last].slice(0, 3)), chunk.map((l) => l.slice(4)).join('\n')]);
    };

    const deadline = setTimeout(() => finish(new SmtpError('timeout', 0)), DEADLINE);
    sock.setTimeout(timeout, () => finish(new SmtpError('timeout', 0)));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > MAX_REPLY) {
        finish(new SmtpError('reply too long', 0));
        return;
      }
      pump();
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () => {
      if (waiter) {
        waiter.rej(new SmtpError('connection closed', 0));
      }
      finish(new SmtpError('connection closed', 0));
    });

    const expect = async (ok, text) => {
      if (text !== undefined) {
        sock.write(text + CRLF);
      }
      const [code, msg] = await reply();
      if (!ok.includes(code)) {
        throw new SmtpError(msg.trim() || `unexpected reply ${code}`, code);
      }
      return msg;
    };

    (async () => {
      await expect([220]);
      await expect([250], 'EHLO appbox');
      const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
      await expect([235], `AUTH PLAIN ${plain}`);
      await expect([250], `MAIL FROM:<${from}>`);
      for (const r of rcpts) {
        await expect([250, 251], `RCPT TO:<${r}>`);
      }
      await expect([354], 'DATA');
      const body = data.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
      await expect([250], `${body}${body.endsWith(CRLF) ? '' : CRLF}.`);
      sock.write(`QUIT${CRLF}`);
      finish(null);
    })().catch((err) => finish(err));
  });
}

module.exports = { sendMail, SmtpError };
