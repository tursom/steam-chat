import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('desktop notifications filter echoes, active reading, duplicate events and stale accounts', () => {
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  const notifications: any[] = [], opened: unknown[] = [];
  class FakeNotification {
    static permission = 'granted';
    onclick?: () => void;
    closed = false;
    constructor(public title: string, public options: unknown) { notifications.push(this); }
    close() { this.closed = true; }
  }
  const state = { me: { id: 1 }, steam: { steamId: 'account' }, view: 'chat', activeId: 'peer', chatPanel: 'thread' };
  let focus = true, epoch = 1, enabled = true;
  const sandbox: any = { Notification: FakeNotification, window: { Notification: FakeNotification, focus() {} }, state,
    document: { visibilityState: 'visible', hasFocus: () => focus },
    localStorage: { getItem: () => String(enabled), setItem() {} },
    steamAccessAllowed: () => true, chatContext: () => String(epoch), resolvedChatEntry: (x: unknown) => x,
    renderShell() {}, openConversation: (...args: unknown[]) => opened.push(args) };
  runInNewContext(source.slice(source.indexOf('const desktopNotificationEvents'), source.indexOf('function receiveHistoryMessage')) + '\nthis.notify = notifyIncomingMessage; this.clear = closeDesktopNotifications;', sandbox);
  const incoming = (eventId: string, extra = {}) => sandbox.notify({ id: 'peer', eventId, name: 'Friend', message: 'private body', ...extra });
  incoming('reading'); assert.equal(notifications.length, 0);
  focus = false;
  incoming('echo', { echo: true }); incoming('foreign', { steamAccountId: 'other' });
  assert.equal(notifications.length, 0);
  incoming('first'); incoming('first');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.body.includes('private body'), false);
  notifications[0].onclick(); assert.equal(opened.length, 1);
  incoming('second'); assert.equal(notifications.length, 2);
  epoch++; notifications[1].onclick(); assert.equal(opened.length, 1);
  enabled = false; incoming('disabled'); assert.equal(notifications.length, 2);
  enabled = true; FakeNotification.permission = 'denied'; incoming('denied'); assert.equal(notifications.length, 2);
  FakeNotification.permission = 'granted'; focus = true; state.activeId = 'another';
  incoming('image', { type: 'image' }); assert.equal(notifications[2].options.body, '发来了一张图片');
  sandbox.clear(); assert.equal(notifications[2].closed, true);
});
