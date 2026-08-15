/**
 * Minimal push-based async queue used to bridge DSH's `session/event` firehose
 * into a channel adapter's pull-based streaming producer.
 * @module dsh-connect/stream
 */
import type { AsyncQueue } from "./types.js";

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  let waiter: (() => void) | undefined;
  let ended = false;

  const wake = () => {
    waiter?.();
    waiter = undefined;
  };

  const queue: AsyncQueue<T> = {
    push(value) {
      if (ended) return;
      buffer.push(value);
      wake();
    },
    end() {
      if (ended) return;
      ended = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift() as T;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
  };

  return queue;
}
