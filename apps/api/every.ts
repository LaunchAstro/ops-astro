// SPDX-License-Identifier: AGPL-3.0-only
//
// A job the API runs on an interval as system work (the reconciliation sweep,
// the trace export and retention): never two runs at once, and a stop that
// waits out the running one, so the server's shutdown closes no pool under it.

import { faultCode } from './alerts/sink.ts';

/**
 * `job` every `ms`, skipped while a run is still going, and a failure logged
 * by its kind only. The returned stop ends the interval and resolves once the
 * running job has ended.
 */
export function every(ms: number, what: string, job: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= job()
      .catch((cause: unknown) => {
        // A listed code only: a database error's text, or a custom name, can carry a value.
        console.error(`api: ${what} failed: ${faultCode(cause)}`);
      })
      .finally(() => {
        running = undefined;
      });
  }, ms);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
