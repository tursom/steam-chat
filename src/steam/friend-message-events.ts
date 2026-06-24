'use strict';

import type { UnknownRecord } from '../types';
import { isRecord } from '../types';

const {
  steamIdToString
} = require('../storage/chat-log');

type FriendMessageEventName = 'friendMessage' | 'friendMessageEcho';

type FriendMessageEmitter = {
  on?: (event: FriendMessageEventName, listener: (...args: unknown[]) => void) => void;
  off?: (event: FriendMessageEventName, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: FriendMessageEventName, listener: (...args: unknown[]) => void) => void;
};

export type SteamFriendMessageEvent = {
  id: string;
  steamID: unknown;
  echo: boolean;
  message: string;
  compatibilityMessage: string;
  ordinal?: string | number;
  serverTimestamp?: Date;
  source: 'chat' | 'legacy';
  raw: unknown;
};

export type SteamFriendMessageEventUser = FriendMessageEmitter & {
  chat?: FriendMessageEmitter;
};

type SteamFriendMessageEventHandler = (event: SteamFriendMessageEvent) => void;

function optionalOrdinal(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value > 1000000000000 ? value : value * 1000);
}

function messageFromRecord(record: UnknownRecord): string {
  if (typeof record.message === 'string') return record.message;
  return typeof record.message_no_bbcode === 'string' ? record.message_no_bbcode : '';
}

function compatibilityMessageFromRecord(record: UnknownRecord, message: string): string {
  return typeof record.message_no_bbcode === 'string' ? record.message_no_bbcode : message;
}

function legacyCompatibilityKey(eventName: FriendMessageEventName, event: Pick<SteamFriendMessageEvent, 'id' | 'compatibilityMessage'>): string {
  return `${eventName}\0${event.id}\0${event.compatibilityMessage}`;
}

function incrementPendingLegacy(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
  setTimeout(() => {
    const next = (map.get(key) || 0) - 1;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }, 1000).unref?.();
}

function consumePendingLegacy(map: Map<string, number>, key: string): boolean {
  const count = map.get(key) || 0;
  if (count <= 0) return false;
  if (count === 1) map.delete(key);
  else map.set(key, count - 1);
  return true;
}

function chatEventFromBody(eventName: FriendMessageEventName, body: unknown): SteamFriendMessageEvent | null {
  if (!isRecord(body)) return null;
  const steamID = body.steamid_friend || body.steamID || body.steamid;
  const id = steamIdToString(steamID);
  if (!id) return null;
  const message = messageFromRecord(body);
  return {
    id,
    steamID,
    echo: eventName === 'friendMessageEcho' || body.local_echo === true,
    message,
    compatibilityMessage: compatibilityMessageFromRecord(body, message),
    ordinal: optionalOrdinal(body.ordinal),
    serverTimestamp: optionalDate(body.server_timestamp || body.timestamp),
    source: 'chat',
    raw: body
  };
}

function legacyEventFromArgs(eventName: FriendMessageEventName, args: unknown[]): SteamFriendMessageEvent | null {
  const [steamID, message] = args;
  const ordinal = eventName === 'friendMessageEcho' ? args[2] : args[4];
  const id = steamIdToString(steamID);
  if (!id) return null;
  const text = typeof message === 'string' ? message : '';
  return {
    id,
    steamID,
    echo: eventName === 'friendMessageEcho',
    message: text,
    compatibilityMessage: text,
    ordinal: optionalOrdinal(ordinal),
    source: 'legacy',
    raw: args
  };
}

function subscribe(emitter: FriendMessageEmitter | undefined, eventName: FriendMessageEventName, listener: (...args: unknown[]) => void) {
  if (typeof emitter?.on !== 'function') return () => {};
  emitter.on(eventName, listener);
  return () => {
    if (typeof emitter.off === 'function') emitter.off(eventName, listener);
    else emitter.removeListener?.(eventName, listener);
  };
}

function subscribeFriendMessageEvents(steamUser: SteamFriendMessageEventUser, handler: SteamFriendMessageEventHandler) {
  const pendingLegacy = new Map<string, number>();
  const disposers: Array<() => void> = [];

  for (const eventName of ['friendMessage', 'friendMessageEcho'] as FriendMessageEventName[]) {
    disposers.push(subscribe(steamUser.chat, eventName, (body: unknown) => {
      const event = chatEventFromBody(eventName, body);
      if (!event) return;
      incrementPendingLegacy(pendingLegacy, legacyCompatibilityKey(eventName, event));
      handler(event);
    }));

    disposers.push(subscribe(steamUser, eventName, (...args: unknown[]) => {
      const event = legacyEventFromArgs(eventName, args);
      if (!event) return;
      if (consumePendingLegacy(pendingLegacy, legacyCompatibilityKey(eventName, event))) return;
      handler(event);
    }));
  }

  return () => {
    for (const dispose of disposers) dispose();
    pendingLegacy.clear();
  };
}

module.exports = {
  subscribeFriendMessageEvents
};
