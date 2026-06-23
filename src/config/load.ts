'use strict';

import type { UnknownRecord } from '../types';
import { isRecord } from '../types';

const path = require('node:path');
const { PROJECT_ROOT } = require('../paths');

function loadConfig(): UnknownRecord {
  try {
    const loaded: unknown = require(path.join(PROJECT_ROOT, 'config'));
    return isRecord(loaded) ? loaded : {};
  } catch (error) {
    if (!isRecord(error) || error.code !== 'MODULE_NOT_FOUND') throw error;
    const example: unknown = require(path.join(PROJECT_ROOT, 'config.example'));
    return isRecord(example) ? example : {};
  }
}

function isChatEnabled(chatConfig: unknown) {
  if (chatConfig === true) return true;
  return Boolean(isRecord(chatConfig) && chatConfig.enabled !== false);
}

module.exports = {
  isChatEnabled,
  loadConfig
};
