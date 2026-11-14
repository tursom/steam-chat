import type { HistoryStorage } from '../storage/history-storage';
import type { LoggerLike } from '../types';

type Emitter = {
  on: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};
export type RecoveryUser = Emitter & {
  myFriends?: Record<string, unknown>;
  chat?: {
    getActiveFriendMessageSessions?: (options: Record<string, never>, callback: (error: unknown,
      response?: { sessions?: Array<{ steamid_friend?: unknown }> }) => void) => unknown;
  };
};

/** Bound callback SDK calls, including implementations that also return a Promise. */
export function steamHistoryCall<T>(call: (callback: (error: unknown, value?: T) => void) => unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error: unknown, value?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new Error('Steam history connection changed'));
    const timer = setTimeout(() => finish(new Error('Steam history request timed out')), timeoutMs);
    const callback = (error: unknown, value?: T) => {
      finish(error, value);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = call(callback);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<T>).then(value => callback(null, value), error => callback(error));
      }
    } catch (error) { callback(error); }
  });
}

export function createHistoryRecovery(options: {
  steamUser: RecoveryUser;
  storage?: HistoryStorage;
  account: () => string | undefined;
  steamId: (value: unknown) => string;
  importHistory: (id: string, account: string | undefined, current: () => boolean, signal: AbortSignal) => Promise<void>;
  logger: LoggerLike;
  retryMs: number;
  timeoutMs: number;
  track: (task: Promise<unknown>) => void;
}) {
  const { steamUser, storage, logger } = options;
  let epoch = 0;
  let account = options.account();
  let online = true;
  let stopped = false;
  let discovered = false;
  let discovery: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;
  const completed = new Set<string>();
  const wanted = new Set<string>();
  const running = new Map<string, Promise<void>>();
  // Each connection owns its queue. A hung old connection cannot block a new login.
  let tail = Promise.resolve();
  let controller = new AbortController();
  const valid = (generation: number, captured: string | undefined) =>
    !stopped && online && epoch === generation && options.account() === captured;

  function scheduleRetry() {
    if (stopped || !online || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!discovered) discover();
      for (const id of wanted) void request(id);
    }, options.retryMs);
    retry.unref?.();
  }

  function reset(connected: boolean) {
    controller.abort();
    controller = new AbortController();
    epoch++;
    account = options.account();
    online = connected;
    completed.clear(); wanted.clear(); running.clear();
    discovered = false; discovery = undefined; tail = Promise.resolve();
    if (retry) clearTimeout(retry);
    retry = undefined;
  }

  function request(id: string): Promise<void> {
    if (options.account() !== account) reset(true);
    if (stopped || !online || !id || completed.has(id)) return Promise.resolve();
    wanted.add(id);
    const existing = running.get(id);
    if (existing) return existing;
    const generation = epoch;
    const captured = account;
    const signal = controller.signal;
    const current = () => valid(generation, captured);
    const task = tail.then(async () => {
      if (!current()) return;
      try {
        await options.importHistory(id, captured, current, signal);
        if (current()) { completed.add(id); wanted.delete(id); }
      } catch (error) {
        if (current()) {
          logger.warn?.('Steam history recovery failed; will retry', { id, error: String(error) });
          scheduleRetry();
        }
      }
    }).finally(() => { if (running.get(id) === task) running.delete(id); });
    running.set(id, task);
    tail = task;
    options.track(task);
    return task;
  }

  function discover() {
    if (stopped || !online || !storage || !account || discovery) return;
    const generation = epoch;
    const captured = account;
    const signal = controller.signal;
    const current = () => valid(generation, captured);
    const task = (async () => {
      let failed = false;
      const add = (id: string) => { if (current() && id && id !== captured) void request(id); };
      // Friends also cover sessions not returned by Steam's recent-session list.
      for (const [id, relationship] of Object.entries(steamUser.myFriends || {})) {
        if (relationship === 3) add(id);
      }
      try {
        const chat = steamUser.chat;
        if (chat?.getActiveFriendMessageSessions) {
          const response = await steamHistoryCall<{ sessions?: Array<{ steamid_friend?: unknown }> }>(
            callback => chat.getActiveFriendMessageSessions!({}, callback), options.timeoutMs, signal);
          if (!current()) return;
          for (const session of response?.sessions || []) add(options.steamId(session.steamid_friend));
        }
      } catch (error) {
        failed = true;
        if (current()) logger.warn?.('Steam session discovery failed; will retry', { error: String(error) });
      }
      try {
        let before: string | undefined;
        const cursors = new Set<string>();
        do {
          if (!current()) return;
          const page = await storage.conversations({ steamAccountId: captured, limit: 100, before });
          if (!current()) return;
          for (const item of page.items) add(item.id);
          before = page.nextCursor;
          if (before && cursors.has(before)) throw new Error('Conversation discovery cursor did not advance');
          if (before) cursors.add(before);
        } while (before);
      } catch (error) {
        failed = true;
        if (current()) logger.warn?.('Local conversation discovery failed; will retry', { error: String(error) });
      }
      if (current()) {
        discovered = !failed;
        if (failed) scheduleRetry();
      }
    })().finally(() => { if (discovery === task) discovery = undefined; });
    discovery = task;
    options.track(task);
  }

  const onLoggedOn = () => { reset(true); discover(); };
  const onFriends = () => {
    if (options.account() !== account) reset(true);
    // friendsList may arrive after the first discovery has already completed.
    for (const [id, relationship] of Object.entries(steamUser.myFriends || {})) {
      if (relationship === 3 && storage) void request(id);
    }
    discover();
  };
  const onDisconnected = () => reset(false);
  const listeners: Array<[string, () => void]> = [
    ['loggedOn', onLoggedOn], ['friendsList', onFriends],
    ['disconnected', onDisconnected], ['loggedOff', onDisconnected]
  ];
  for (const [event, listener] of listeners) steamUser.on(event, listener);
  return {
    request,
    stop() {
      stopped = true;
      reset(false);
      for (const [event, listener] of listeners) {
        if (steamUser.off) steamUser.off(event, listener);
        else steamUser.removeListener?.(event, listener);
      }
    }
  };
}
