'use strict';

const path = require('node:path');

const BUILD_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.basename(BUILD_ROOT) === 'dist' ? path.resolve(BUILD_ROOT, '..') : BUILD_ROOT;
const WEB_DIR = path.join(BUILD_ROOT, 'web');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const CHAT_LOG_PATH = path.join(LOG_DIR, 'chat.jsonl');
const IMAGE_CACHE_DIR = path.join(LOG_DIR, 'images');
const STICKER_CACHE_DIR = path.join(LOG_DIR, 'stickers');
const REFRESH_TOKEN_PATH = path.join(PROJECT_ROOT, 'refresh.token');

module.exports = {
  CHAT_LOG_PATH,
  IMAGE_CACHE_DIR,
  LOG_DIR,
  PROJECT_ROOT,
  REFRESH_TOKEN_PATH,
  STICKER_CACHE_DIR,
  WEB_DIR
};
