import { EventEmitter } from 'node:events';

type Client = EventEmitter & { logOff?: () => void };

/** Stable application reference; SDK-internal listeners stay on their own instance. */
export function replaceableSteamClient<T extends Client>(factory: () => T): { client: T; replace: () => void } {
  const events = new EventEmitter();
  let current: T;
  function make() {
    const instance = factory();
    // Retired SDK authentication promises may still reject asynchronously.
    instance.on('error', () => {});
    const emit = instance.emit;
    instance.emit = function (event: string | symbol, ...args: any[]) {
      const result = emit.call(this, event, ...args);
      if (instance !== current) {
        if (event === 'loggedOn') instance.logOff?.();
        return result;
      }
      return events.emit(event, ...args) || result;
    };
    return instance;
  }
  current = make();
  const eventMethods = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'listenerCount', 'listeners', 'rawListeners', 'eventNames', 'setMaxListeners', 'getMaxListeners', 'prependListener', 'prependOnceListener']);
  const client = new Proxy({} as T, {
    get(_target, key) {
      if (eventMethods.has(String(key))) return (events as any)[key].bind(events);
      const value = (current as any)[key];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, key, value) { (current as any)[key] = value; return true; }
  });
  return { client, replace() {
    const next = make();
    const previous = current;
    current = next; // Retire before logOff can synchronously emit events.
    try { previous.logOff?.(); } catch { /* Its events are already isolated. */ }
    process.nextTick(() => { try { previous.logOff?.(); } catch {} });
  } };
}
