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

// What a watcher off the machine cannot reach, the sink's own rule
// (`apps/api/alerts/sink.ts`).
import { UNREACHABLE } from '../../apps/api/alerts/sink.ts';

export { UNREACHABLE };

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
