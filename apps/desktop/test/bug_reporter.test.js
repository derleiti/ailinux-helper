'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reporter = require('../bug_reporter');

test('bug reporter redacts credentials and share ids', () => {
  const text = reporter.redact('Authorization: Bearer abc token=secret AAAA-BBBB-CCCC-DDDD-EEEE-FFFF https://x/?key=nope');
  assert.doesNotMatch(text, /abc|secret|AAAA-BBBB|nope/);
  assert.match(text, /\[REDACTED\]/);
});

test('bug reporter scrubs nested secret keys', () => {
  const value = reporter.scrub({ token: 'x', nested: { password: 'y', safe: 'ok' } });
  assert.equal(value.token, '[REDACTED]');
  assert.equal(value.nested.password, '[REDACTED]');
  assert.equal(value.nested.safe, 'ok');
});
