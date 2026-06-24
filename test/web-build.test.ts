'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('web app build emits a browser-compatible script', () => {
  const appPath = path.resolve(__dirname, '../web/app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');

  assert.doesNotMatch(appSource, /\bexports\b|module\.exports|require\(/);
});
