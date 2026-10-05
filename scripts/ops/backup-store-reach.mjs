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
// A reach takes a login address and a script and answers what `psql -At`
// prints. It throws a bare error on any failure: psql's and the server's
// messages can carry a host or a login, so they are discarded. An archive can
// be as large as the store's cap (REV158S criterion 5), so neither end is ever
// held whole: a script may be a list or a stream of pieces, written to psql as
// psql takes them, and a caller that passes `onLine` is handed each printed
// line in turn instead of the whole output. The container's lifetime is
// container-run.mjs's: a refusal, a deadline or a failed client removes it.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { containerArgs, runContainer } from './container-run.mjs';

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

const LOGIN = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'];
const TYPES = new Set(['text', 'uuid', 'timestamptz', 'integer', 'bigint', 'jsonb', 'bytea']);
const PSQL = ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
const REFUSED = 'a database address is not of the one shape a login takes';

// The TLS modes an address may ask for: none weaker than the reach's own.
const SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);
// One host name or IPv4 address; never a libpq host list or an escape.
const HOST = /^[A-Za-z0-9.-]+$/u;

/**
 * A login address, read whole by the URL parser into the parts psql is
 * given, and refused unless it is exactly `postgres[ql]://user[:password]@
 * host[:port]/database`, with at most one query parameter, `sslmode`, of a
 * mode in `SSLMODES` (staging-logins.ts writes `sslmode=require`). No other
 * parameter, fragment, host list or second path segment, since psql is
 * handed the parts alone and would drop anything else unseen (#408). The
 * parser must read it back exactly as written, so a dot segment it would
 * drop is refused too. The refusal carries no part of the address (#446).
 */
function loginParts(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(REFUSED);
  }
  const path = parsed.pathname.slice(1);
  // Read back exactly as written: the parser drops dot segments, so
  // `/store/../other` would otherwise name `other` (Sol PRV-oa-968-R1.3).
  const asWritten = parsed.href === address;
  const query = [...parsed.searchParams];
  const sslmode = query[0]?.[1] ?? 'require';
  const shaped =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (query.length === 0 || (query.length === 1 && query[0][0] === 'sslmode')) &&
    SSLMODES.has(sslmode) &&
    parsed.hash === '' &&
    HOST.test(parsed.hostname) &&
    parsed.username !== '' &&
    parsed.pathname.startsWith('/') &&
    path !== '' &&
    !path.includes('/') &&
    asWritten;
  if (!shaped) throw new Error(REFUSED);
  let parts;
  try {
    parts = {
      host: parsed.hostname,
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(path),
      sslmode,
    };
  } catch {
    throw new Error(REFUSED);
  }
  if (Object.values(parts).some((part) => part.includes('\0'))) throw new Error(REFUSED);
  return parts;
}

/**
 * The psql environment for a login address (`loginParts`): TLS required, at
 * the address's own mode when it names a stricter one, and
 * a connect bound in seconds only when one is given. pg_dump takes the same.
 */
export function reachEnv(url, connectSeconds) {
  const login = loginParts(url);
  const limit = connectSeconds === undefined ? {} : { PGCONNECT_TIMEOUT: String(connectSeconds) };
  return {
    PGHOST: login.host,
    PGPORT: login.port,
    PGUSER: login.user,
    PGPASSWORD: login.password,
    PGDATABASE: login.database,
    PGSSLMODE: login.sslmode,
    ...limit,
  };
}

/** `docker` arguments for one psql script on `network`: no port, the login by name only. */
export function reachArgs(network, names = LOGIN) {
  return containerArgs('store', network, names, PSQL, { stdin: true });
}

/**
 * A reach through psql on `network`: `script` is text or pieces of text. With
 * `connectSeconds`, psql gives up connecting after that; with `timeoutMs`, the
 * run is stopped after that whatever it is waiting on. The store's reach has
 * neither.
 */
export function psqlOn(network, { connectSeconds, timeoutMs } = {}) {
  return async (url, script, onLine) => {
    const login = reachEnv(url, connectSeconds);
    const run = runContainer('store', network, login, PSQL, { stdin: true });
    const deadline =
      timeoutMs === undefined ? undefined : setTimeout(() => stopQuietly(run), timeoutMs);
    try {
      const pieces = typeof script === 'string' ? [script] : script;
      // One piece ahead at most: a piece can be one part's hex, 8 MiB.
      const source = Readable.from(pieces, { objectMode: true, highWaterMark: 1 });
      const sent = pipeline(source, run.child.stdin).then(
        () => true,
        () => false,
      );
      const [succeeded, written, printed] = await Promise.all([
        run.exited,
        sent,
        readOut(run, onLine),
      ]);
      if (printed.error !== undefined) throw printed.error;
      if (!succeeded || !written) throw new Error('the store refused or could not be reached');
      return printed.text;
    } finally {
      clearTimeout(deadline);
    }
  };
}

/** Stops `run` without waiting; a container left behind reaches the reach through `run.exited`. */
function stopQuietly(run) {
  run.stop().catch(() => {});
}

/** psql's output: whole, or line by line to `onLine`, stopping the run if `onLine` throws. */
async function readOut(run, onLine) {
  if (onLine === undefined) {
    const chunks = [];
    for await (const chunk of run.child.stdout) chunks.push(chunk);
    return { text: Buffer.concat(chunks).toString().replace(/\n$/u, '') };
  }
  let error;
  for await (const line of createInterface({ input: run.child.stdout, crlfDelay: Infinity })) {
    if (error !== undefined) continue;
    try {
      await onLine(line);
    } catch (thrown) {
      error = thrown;
      stopQuietly(run);
    }
  }
  return { text: '', error };
}

/** The route the job and the drill take on staging. */
export const stagingReach = psqlOn(staging.networks.staging.name);

/** The same route, bounded (`psqlOn`), for a hop that must not hold up its job. */
export const stagingReachWithin = (bounds) => psqlOn(staging.networks.staging.name, bounds);

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
 * Parameter `n` of a `bound` statement, read back as `type`: the value goes
 * as the hex of its UTF-8 text, and the empty text is null.
 */
export function param(n, type) {
  if (!Number.isSafeInteger(n) || n < 1 || !TYPES.has(type) || type === 'bytea') {
    throw new Error(`no such parameter: ${n} ${type}`);
  }
  return `nullif(convert_from(decode($${n}, 'hex'), 'UTF8'), '')::${type}`;
}

/**
 * One statement whose values go as bound parameters (psql's `\\bind`), never
 * in its text, so no statement the server logs or reports carries them. Each
 * value goes as the hex of its text (`param` reads it back), so what psql is
 * handed is hex digits alone, whatever the value holds: no quote, backslash or
 * newline can end it (SLOW-V2 row 9). A string, number or JSON object is a
 * value; null or undefined goes as null; anything else is refused.
 */
export function bound(sql, params) {
  const args = params.map((v) => {
    if (v === null || v === undefined) return "''";
    let text;
    if (typeof v === 'string') text = v;
    else if (typeof v === 'number' && Number.isFinite(v)) text = String(v);
    else if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      text = JSON.stringify(v);
    } else throw new Error('a bound value is a string, a number or a plain object');
    return `'${Buffer.from(text, 'utf8').toString('hex')}'`;
  });
  return `${sql} \\bind ${args.join(' ')} \\g\n`;
}
