// Exercise a stalled native writer without blocking the independent log process.
process.once('message', (message: { id: number; method: string; value: { kind: string } }) => {
  if (message.value.kind === 'rocksdb') {
    process.send?.({ id: message.id, result: true });
    process.on('message', () => { /* Simulate an unresponsive native call. */ });
  } else {
    require('../../src/storage/history-worker');
    process.emit('message', message, undefined);
  }
});
