// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way the scheduled backup job and the restore drill reach the backup
// store (ticket S0-3, lines C1, C2 and C11; ORCH25-SL01-STORE). The store,
// `backups` in deploy/staging/compose.json, publishes no port and sits only on
// staging's internal network, so nothing on the machine connects to it. Each
// call sends one psql script, over stdin, to a throwaway container of
// staging's pinned Postgres image on that network. The login goes to psql as
// named environment variables, never on the command line, and TLS is
// required. Every value a caller passes goes into the script as hex, through
// `value`, so none is ever read as SQL or as a psql command.
//
// A reach takes a login URL and a script and answers what `psql -At` prints.
// It throws a bare error on any failure: psql's and the server's messages can
// carry a host or a login, so they are discarded.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

const LOGIN = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'];
const TYPES = new Set(['text', 'uuid', 'timestamptz', 'integer', 'jsonb', 'bytea']);

/** The psql environment for a login URL: the parts named, the password decoded, TLS required. */
export function reachEnv(url) {
  const parsed = new URL(url);
  return {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGSSLMODE: 'require',
  };
}

/** `docker` arguments for one psql script on `network`: no port, the login by name only. */
export function reachArgs(network) {
  return [
    'run',
    '--rm',
    '-i',
    `--name=${staging['x-ops-astro'].ownPrefix}-store-${randomBytes(4).toString('hex')}`,
    `--network=${network}`,
    ...LOGIN.map((name) => `--env=${name}`),
    staging.services.db.image,
    'psql',
    '-X',
    '-q',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '-',
  ];
}

/** A reach through psql on `network`. */
export function psqlOn(network) {
  return (url, script) =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', reachArgs(network), {
        env: { ...process.env, ...reachEnv(url) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', () => reject(new Error('the store could not be reached')));
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString().replace(/\n$/u, ''));
        else reject(new Error('the store refused or could not be reached'));
      });
      child.stdin.end(script);
    });
}

/** The route the job and the drill take on staging. */
export const stagingReach = psqlOn(staging.networks.staging.name);

/** A value as SQL: hex inside the script, then cast; null stays null. */
export function value(v, type) {
  if (!TYPES.has(type)) throw new Error(`no such value type: ${type}`);
  if (v === null || v === undefined) return `null::${type}`;
  if (type === 'bytea') return `decode('${Buffer.from(v).toString('hex')}', 'hex')`;
  const text = type === 'jsonb' ? JSON.stringify(v) : String(v);
  return `convert_from(decode('${Buffer.from(text, 'utf8').toString('hex')}', 'hex'), 'UTF8')::${type}`;
}
