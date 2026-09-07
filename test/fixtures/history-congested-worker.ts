process.once('message', (message: { id: number; method: string; value: { kind: string } }) => {
  if (message.value.kind === 'rocksdb') {
    process.send?.({ id: message.id, result: true });
    process.on('message', (request: { id: number; method: string }) => {
      if (request.method === 'history') setTimeout(() => process.send?.({ id: request.id, result: { items: [] } }), 500);
      else process.send?.({ id: request.id, result: true });
    });
  } else {
    require('../../src/storage/history-worker');
    process.emit('message', message, undefined);
  }
});
