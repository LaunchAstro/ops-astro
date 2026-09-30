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

export { offEgress, ping, UNREACHABLE } from '../../apps/worker/heartbeat.ts';

/**
 * Whether the error sink behind `dsn` answers its health page. The sink is on
 * the machine, where the off-box watcher cannot see it, so its forwarder asks
 * and pings the sink's heartbeat only on a yes. The key in the DSN is not sent.
 */
export async function sinkAnswers(dsn, get = fetch) {
  try {
    const health = new URL('/_health/', new URL(dsn).origin);
    const answer = await get(health, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    await answer.body?.cancel();
    return answer.status >= 200 && answer.status < 300;
  } catch {
    return false;
  }
}
