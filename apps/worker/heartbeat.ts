// SPDX-License-Identifier: AGPL-3.0-only
//
// The watcher's ping, shared by the worker and the scheduled jobs on the
// machine (`scripts/ops/heartbeat.mjs` re-exports it; its header says how a
// heartbeat is used). The address carries the watcher's token, so the outcome
// is a word, never the address.

// What a watcher off the machine cannot reach: loopback, private, shared, link-local
// (the metadata address), IPv6 literals and local names. URL has already
// normalised case and numeric forms (2130706433 and 0x7f.0.0.1 read as 127.0.0.1).
export const UNREACHABLE: RegExp =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|0\.|\[)|(^|\.)(localhost|local|internal|lan)\.?$/u;

/** One ping to `address`; the outcome in a word, never the address. */
export async function ping(
  address: string | undefined,
  get: typeof fetch = fetch,
): Promise<'sent' | 'failed' | 'refused' | 'not set'> {
  if (address === undefined || address === '') return 'not set';
  const url = URL.parse(address);
  if (url === null || url.protocol !== 'https:' || UNREACHABLE.test(url.hostname)) return 'refused';
  try {
    const answer = await get(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    await answer.body?.cancel();
    return answer.status >= 200 && answer.status < 300 ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
