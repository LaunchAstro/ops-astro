// SPDX-License-Identifier: AGPL-3.0-only
//
// The off-box watcher's heartbeats (tickets S0-2 and S0-3). A scheduled job
// that finished its work pings its heartbeat address; the watcher (UptimeRobot)
// mails the owner and the second operator when a ping is late, in the words of
// `apps/api/alerts/catalogue.ts`. A job that did not finish, or found something
// stale, does not ping, and silence is the alert.
//
// The address carries the watcher's token, so it is never printed: a run's
// record says only `sent`, `failed`, `refused` or `not set`. The one request is
// a GET to a public https address, with no redirect followed, a 10-second
// limit and its answer's body discarded.

// What a watcher off the machine cannot reach: loopback, private, shared, link-local
// (the metadata address), IPv6 literals and local names. URL has already
// normalised case and numeric forms (2130706433 and 0x7f.0.0.1 read as 127.0.0.1).
export const UNREACHABLE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|0\.|\[)|(^|\.)(localhost|local|internal|lan)\.?$/u;

/** One ping to `address`; the outcome in a word, never the address. */
export async function ping(address, get = fetch) {
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
