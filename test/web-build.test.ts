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

test('web app build emits the local chat icon assets', () => {
  const iconDir = path.resolve(__dirname, '../web/icons');
  const icons = ['arrow-left', 'image', 'link', 'paperclip', 'plus', 'search', 'send', 'smile', 'x', 'panel-right', 'messages-square', 'gamepad-2', 'users', 'settings-2', 'shield', 'scroll-text', 'log-out', 'external-link'];

  for (const icon of icons) {
    const source = fs.readFileSync(path.join(iconDir, `${icon}.svg`), 'utf8');
    assert.match(source, /@license lucide/);
    assert.match(source, /<svg\b/);
  }
});
