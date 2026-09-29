// SPDX-License-Identifier: AGPL-3.0-only
//
// The alerts, the owner's command (ticket S0-2).
//
//   node scripts/ops/alerts.mjs plan [--test]
//   node scripts/ops/alerts.mjs test
//
// `plan` prints what the off-box watcher (UptimeRobot) and the error sink
// (GlitchTip) are set up with: each check, named in plain words, and who is
// mailed; it registers nothing. `--test` mails the agreed test address instead,
// for case R8. `test` sends one test alert through the sink. Settings come from
// the environment (deploy/staging/README.md); exit 1 names a bad one, never its value.

import { plainAlert } from '../../apps/api/alerts/catalogue.ts';
import { alertEvent, dsnTransport, sinkFrom } from '../../apps/api/alerts/sink.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// What a watcher off the machine cannot reach: loopback, private, link-local, local names.
const UNREACHABLE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)|\.(local|internal|lan)$/u;

class Refusal extends Error {}

function setting(name, valid = () => true, why = 'is not set') {
  const value = process.env[name] ?? '';
  if (value === '' || !valid(value)) {
    throw new Refusal(`${name} ${value === '' ? 'is not set' : why}.`);
  }
  return value;
}

const email = (name) => setting(name, (v) => EMAIL.test(v), 'is not an email address');

function watched(name) {
  const why = 'must be a public https address the off-box watcher can reach';
  const url = new URL(setting(name, (v) => URL.parse(v)?.protocol === 'https:', why));
  if (UNREACHABLE.test(url.hostname)) throw new Refusal(`${name} ${why}.`);
  return url.origin + url.pathname.replace(/\/?$/u, '/');
}

function monitorsFor(where, base) {
  const check = (watch, type, url, kind) => {
    return { environment: where, watch, type, url, name: plainAlert(kind, where).title };
  };
  return [
    check('web', 'http', base, 'web-down'),
    check('api', 'http', `${base}api/health`, 'api-down'),
    check('backup', 'heartbeat', undefined, 'backup-silent'),
  ];
}

function plan(test) {
  const operators = [email('OPS_ALERT_OWNER_EMAIL'), email('OPS_ALERT_SECOND_OPERATOR_EMAIL')];
  const recipients = test ? [email('OPS_ALERT_TEST_EMAIL')] : operators;
  const dsn = setting('OPS_ERROR_SINK_DSN');
  dsnTransport(dsn);
  const monitors = monitorsFor('staging', watched('OPS_WATCH_STAGING_URL'));
  if (process.env['OPS_WATCH_PRODUCTION_URL']) {
    monitors.push(...monitorsFor('production', watched('OPS_WATCH_PRODUCTION_URL')));
  }
  const sink = new URL(dsn);
  const name = plainAlert('sink-down', 'staging').title;
  monitors.push({ watch: 'error sink', type: 'http', url: `${sink.origin}/_health/`, name });
  const every = 'every minute; mail at once when a check fails and when it is back';
  const rule = 'every event, at once, by email';
  const out = { channel: 'email', recipients, every, monitors, sink: { rule, recipients } };
  console.log(JSON.stringify(out, null, 2));
}

async function sendTest() {
  const sink = sinkFrom(process.env);
  if (sink === undefined) throw new Refusal('OPS_ERROR_SINK_DSN is not set.');
  try {
    await sink.send(alertEvent('test', sink.where));
  } catch {
    throw new Refusal('the error sink did not take the test alert; check it is running.');
  }
  console.log(`alerts: test alert sent from ${sink.where}; it should arrive within a few minutes.`);
}

const [command, ...rest] = process.argv.slice(2);
const planning = command === 'plan' && (rest.length === 0 || rest.join(' ') === '--test');
if (!planning && !(command === 'test' && rest.length === 0)) {
  console.error('alerts: usage: node scripts/ops/alerts.mjs plan [--test] | test');
  process.exit(2);
}
try {
  if (planning) plan(rest[0] === '--test');
  else await sendTest();
} catch (error) {
  // A refusal of ours, or the DSN check's, which names its setting.
  if (!(error instanceof Refusal) && !String(error.message).startsWith('OPS_')) throw error;
  console.error(`alerts: ${error.message}`);
  process.exit(1);
}
