'use strict';

import type { UnknownRecord } from '../types';
import { isRecord } from '../types';

const path = require('node:path');
const { PROJECT_ROOT } = require('../paths');

function loadConfig(): UnknownRecord {
  let fileConfig: UnknownRecord = {};
  try {
    const loaded: unknown = require(path.join(PROJECT_ROOT, 'config'));
    fileConfig = isRecord(loaded) ? loaded : {};
  } catch (error) {
    if (!isRecord(error) || error.code !== 'MODULE_NOT_FOUND') throw error;
  }

  const chatInput = isRecord(fileConfig.chat) ? fileConfig.chat : {};
  const chat = {
    ...chatInput,
    host: process.env.STEAM_CHAT_HOST || chatInput.host || '0.0.0.0',
    port: Number.parseInt(String(process.env.STEAM_CHAT_PORT || chatInput.port || 3000), 10),
    wsPath: process.env.STEAM_CHAT_WS_PATH || chatInput.wsPath || '/ws'
  };

  return {
    ...fileConfig,
    chat
  };
}

function isChatEnabled(chatConfig: unknown) {
  if (chatConfig === true) return true;
  return Boolean(isRecord(chatConfig) && chatConfig.enabled !== false);
}

module.exports = {
  isChatEnabled,
  loadConfig
};
