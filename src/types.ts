export type UnknownRecord = Record<string, unknown>;

export type LoggerLike = {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
  log?: (message: string, meta?: unknown) => void;
};

export type SteamIdLike = {
  getSteamID64?: () => string;
  steamid?: string | number;
};

export type Persona = UnknownRecord & {
  player_name?: string;
  personaName?: string;
  name?: string;
  avatar_url_icon?: string;
  avatar_url_medium?: string;
  avatar?: string;
  persona_state?: number;
  personaState?: number;
  game_name?: string;
  gameName?: string;
};

export type ChatConfig = {
  enabled: boolean;
  host: string;
  port: number;
  wsPath: string;
  auth: AuthConfig;
};

export type AuthConfig = {
  username?: string;
  password?: string;
  realm?: string;
  trustProxy?: boolean;
};

export type HistoryRecordInput = UnknownRecord & {
  type?: string;
  date?: string;
  echo?: boolean;
  id?: string | number | SteamIdLike;
  steamID?: string | number | SteamIdLike;
  name?: string;
  message?: string;
  imageUrl?: string | null;
  ordinal?: string | number | null;
  sentAt?: string;
};

export type HistoryItem = {
  type: string;
  date: string;
  echo: boolean;
  id: string;
  name: string;
  message: string;
  imageUrl: string | null;
  ordinal: number | string | null;
  sentAt?: string;
};

export type ConversationSummary = {
  id: string;
  name: string;
  updatedAt: string;
  preview: string;
  lastType: string;
  lastEcho: boolean;
  messageCount: number;
};

export type ChatMessagePayload = HistoryItem & {
  type: string;
  requestId?: string;
  error?: string;
  wsPath?: string;
};

export type CallbackStyleFunction = (...args: unknown[]) => unknown;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

export function errorCode(error: unknown): string {
  if (!isRecord(error)) return errorMessage(error);
  return String(error.eresult || error.code || error.message || error);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
