import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('notification audio defaults to Steam, respects mute, throttles and previews each preset', async () => {
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  const preferences = new Map<string, string>();
  const played: string[] = [];
  let time = 10000, rejected = false;
  class Audio {
    src = ''; volume = 1;
    pause() {}
    async play() { if (rejected) throw new Error('NotAllowedError'); played.push(this.src); }
  }
  const context: any = { Audio, Date: { now: () => time }, localStorage: { getItem: (key: string) => preferences.get(key) } };
  runInNewContext(source.slice(source.indexOf('const notificationSounds'), source.indexOf('function notificationSoundControls')) + '\nthis.play = playNotificationSound;', context);
  assert.equal(await context.play(), true);
  assert.deepEqual(played, ['/sounds/steam-message.m4a']);
  assert.equal(await context.play(), false);
  time += 1600;
  preferences.set('steam-chat.sound-enabled', 'false');
  assert.equal(await context.play(), false);
  preferences.set('steam-chat.notification-sound', 'steam-room');
  assert.equal(await context.play(true), true);
  assert.equal(played.at(-1), '/sounds/steam-room.m4a');
  preferences.set('steam-chat.notification-sound', 'steam-mention');
  await context.play(true); assert.equal(played.at(-1), '/sounds/steam-mention.m4a');
  preferences.set('steam-chat.notification-sound', '../invalid');
  await context.play(true); assert.equal(played.at(-1), '/sounds/steam-message.m4a');
  rejected = true; assert.equal(await context.play(true), false);
});
