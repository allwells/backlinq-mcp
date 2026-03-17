// Async semaphore — caps concurrent Moz API calls to avoid hitting rate limits.
// Moz paid plan allows 200 req/s; default cap of 10 concurrent is conservative.

const MAX_CONCURRENT = Number(process.env.MOZ_CONCURRENCY) || 10;

let active = 0;
const queue: Array<() => void> = [];

function release(): void {
  active--;
  if (queue.length > 0) {
    active++;
    queue.shift()!();
  }
}

export async function withMozLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) {
    active++;
  } else {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  try {
    return await fn();
  } finally {
    release();
  }
}
