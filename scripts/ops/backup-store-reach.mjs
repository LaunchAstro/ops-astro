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
// carry a host or a login, so they are discarded. An archive can be as large
// as the store's cap (REV158S criterion 5), so neither end is ever held whole:
// a script may be a list or a stream of pieces, written to psql as psql takes
// them, and a caller that passes `onLine` is handed each printed line in turn
// instead of the whole output.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

/** A reach through psql on `network`: `script` is text or pieces of text. */
export function psqlOn(network) {
  return async (url, script, onLine) => {
    const child = spawn('docker', reachArgs(network), {
      env: { ...process.env, ...reachEnv(url) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (code) => resolve(code));
    });
    const pieces = typeof script === 'string' ? [script] : script;
    // One piece ahead at most: a piece can be one part's hex, 8 MiB.
    const source = Readable.from(pieces, { objectMode: true, highWaterMark: 1 });
    const sent = pipeline(source, child.stdin).then(
      () => true,
      () => false,
    );
    const [code, written, printed] = await Promise.all([exited, sent, readOut(child, onLine)]);
    if (printed.error !== undefined) throw printed.error;
    if (code === -1) throw new Error('the store could not be reached');
    if (code !== 0 || !written) throw new Error('the store refused or could not be reached');
    return printed.text;
  };
}

/** psql's output: whole, or line by line to `onLine`, stopping psql if `onLine` throws. */
async function readOut(child, onLine) {
  if (onLine === undefined) {
    const chunks = [];
    for await (const chunk of child.stdout) chunks.push(chunk);
    return { text: Buffer.concat(chunks).toString().replace(/\n$/u, '') };
  }
  let error;
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (error !== undefined) continue;
    try {
      await onLine(line);
    } catch (thrown) {
      error = thrown;
      child.kill();
    }
  }
  return { text: '', error };
}

/** The route the job and the drill take on staging. */
export const stagingReach = psqlOn(staging.networks.staging.name);

// The most bytes one `decode` holds: its hex is twice that, far inside a string.
const PIECE = 4 * 1024 * 1024;

/**
 * Bytes as SQL, lazily: one `decode` per piece, joined by `||`, handed out one
 * at a time so a script can stream them; as text only when it is small.
 */
function bytea(v) {
  const bytes = Buffer.isBuffer(v) ? v : Buffer.from(v);
  function* pieces() {
    if (bytes.length === 0) yield "decode('', 'hex')";
    for (let at = 0; at < bytes.length; at += PIECE) {
      const hex = bytes.subarray(at, at + PIECE).toString('hex');
      yield `${at === 0 ? '' : ' || '}decode('${hex}', 'hex')`;
    }
  }
  return { [Symbol.iterator]: pieces, toString: () => [...pieces()].join('') };
}

/** A value as SQL: hex inside the script, then cast; null stays null. */
export function value(v, type) {
  if (!TYPES.has(type)) throw new Error(`no such value type: ${type}`);
  if (v === null || v === undefined) return `null::${type}`;
  if (type === 'bytea') return bytea(v);
  const text = type === 'jsonb' ? JSON.stringify(v) : String(v);
  return `convert_from(decode('${Buffer.from(text, 'utf8').toString('hex')}', 'hex'), 'UTF8')::${type}`;
}

/**
 * One statement whose values go as bound parameters (psql's `\bind`), never
 * in its text, so no statement the server logs or reports carries them. Each
 * value is text of a fixed shape, checked by its caller; a null goes as the
 * empty text, which the statement reads back with `nullif($n, '')`. A value
 * that could end its quoting is refused.
 */
export function bound(sql, params) {
  const args = params.map((v) => {
    const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/['\\\n\r]/u.test(text)) throw new Error('a bound value is not of its fixed shape');
    return `'${text}'`;
  });
  return `${sql} \\bind ${args.join(' ')} \\g\n`;
}
