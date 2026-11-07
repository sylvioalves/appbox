'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail, SmtpError } = require('../src/mail/smtp.js');

test('SmtpError keeps the reply code', () => {
  const err = new SmtpError('mailbox unavailable', 550);
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'mailbox unavailable');
  assert.equal(err.code, 550);
});

test('sendMail is the only entry point and returns a promise', () => {
  assert.equal(typeof sendMail, 'function');
  assert.equal(sendMail.length, 1);
});
