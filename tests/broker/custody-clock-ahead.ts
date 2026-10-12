// SPDX-License-Identifier: AGPL-3.0-only
//
// A pause between a caller's lease and custody's send, longer than a case can
// wait for. While `work` runs, this process's wall clock reads `ms` behind
// custody's, so every reading the caller takes for its lease is `ms` old by the
// time custody, on its own clock, meets the request: as if the call had waited
// that long on its way out. The monotonic clock is left alone.

import { vi } from 'vitest';

export async function custodyAhead<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const real = Date.now.bind(Date);
  const behind = vi.spyOn(Date, 'now').mockImplementation(() => real() - ms);
  try {
    return await work();
  } finally {
    behind.mockRestore();
  }
}
