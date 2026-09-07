// Display metadata must never indefinitely delay recording an already received/sent message.
export function settleMetadata<T>(task: Promise<T>, fallback: T, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    task.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}
