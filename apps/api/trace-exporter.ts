// SPDX-License-Identifier: AGPL-3.0-only
//
// The diagnostic trace export, as the API's composition root turns it on (AW-13).
//
// **One configuration change turns it on.** The operator stages the target's
// origin, custody's credentials file and the trace key's file, then sets
// `TRACE_EXPORT=on`. Unset or `off`, nothing starts and the staged settings
// are not read. On with a setting missing or malformed, the server stops
// with a problem naming the setting and never its value. It is an
// installation setting recorded in the deploy record, never a product
// command, and nothing on the wire reaches it.
//
// **Delivery is custody's egress.** The exporter starts a custody process of
// its own whose one destination is the trace target, so the target's key
// stays out of this process, redirects are refused and replies are bounded
// by time and bytes. The pinned target takes its project key pair as HTTP
// Basic: the credentials file stores it as `user:secret` under
// `scheme: "basic"`. The trace key (the HMAC key the ids are derived under)
// is read here, from a file only its owner may read: the exporter derives
// the ids, and the target never holds it.
//
// **Retention is the same custody's.** The destination names the fixed
// ingestion-version header and the two routes retention needs (the delete
// and the read that confirms it); custody sets and allows nothing else.
//
// The export runs on an interval, over the deployment's businesses, after
// the port is bound, beside the sweep; retention runs hourly the same way. Each tick exports every business
// until it is caught up or a gap is recorded; a failure is logged with its
// kind only and the next tick tries again. No run waits on it.

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import {
  parseDestinations,
  startCustody,
  type Custody,
  type Destination,
} from '../../packages/core-custody/src/index.ts';
import {
  expireOnce,
  exportOnce,
  type Deliver,
  type Delivered,
  type ExpiryPorts,
  type TraceDatabase,
} from '../../packages/core-runtime/src/index.ts';
import type { CustodyOutcome } from '../../packages/core-custody/src/index.ts';

export const TRACE_EXPORT_SWITCH = 'TRACE_EXPORT';
export const TRACE_EXPORT_SETTINGS = [
  'TRACE_EXPORT_ORIGIN',
  'TRACE_EXPORT_CREDENTIALS_FILE',
  'TRACE_EXPORT_KEY_FILE',
] as const;

/** The target's one destination key and its credential's reference in custody's file. */
export const TRACE_DESTINATION = 'trace_target';
export const TRACE_CREDENTIAL = 'trace_key';
/** The OpenTelemetry trace path of the pinned profile's target. */
export const TRACE_PATH = '/api/public/otel/v1/traces';
/** The target's trace deletion (a list of ids), and one trace read back by id beneath it. */
export const TRACE_EXPIRY_PATH = '/api/public/traces';
/**
 * The ingestion-version header the contract wants on every request (Langfuse
 * CONTRACT line 375); the value is the vendor's documented one for its v4
 * data model. Custody sets it from this destination, never from a caller.
 */
export const TRACE_HEADERS: Readonly<Record<string, string>> = {
  'x-langfuse-ingestion-version': '4',
};

const EVERY_MS = 30_000;
/** Retention runs hourly: its window is days, and each pass is paged and confirmed. */
const RETAIN_EVERY_MS = 60 * 60_000;
/** Batches per business per tick, so one busy business cannot hold the others. */
const BATCHES_PER_TICK = 20;

export type TraceExportSettings =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'on';
      readonly destination: Destination;
      readonly credentialsFile: string;
      readonly key: Buffer;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

const invalid = (problem: string): TraceExportSettings => ({ kind: 'invalid', problem });

/** Plain http only to this machine: the Basic pair would otherwise cross a network in clear. */
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;

export function traceExportSettings(
  environment: Readonly<Record<string, string | undefined>>,
): TraceExportSettings {
  const toggle = environment[TRACE_EXPORT_SWITCH] ?? '';
  if (toggle === '' || toggle === 'off') return { kind: 'off' };
  if (toggle !== 'on') return invalid(`${TRACE_EXPORT_SWITCH} is neither on nor off`);
  const value = (name: (typeof TRACE_EXPORT_SETTINGS)[number]): string => environment[name] ?? '';
  const missing = TRACE_EXPORT_SETTINGS.filter((name) => value(name) === '');
  if (missing.length > 0) {
    return invalid(`trace export is on but not set: ${missing.join(', ')}`);
  }
  const parsed = parseDestinations([traceDestination(value('TRACE_EXPORT_ORIGIN'))]);
  const destination = parsed.ok ? parsed.destinations.get(TRACE_DESTINATION) : undefined;
  if (destination === undefined) {
    return invalid('TRACE_EXPORT_ORIGIN is not a bare http(s) origin');
  }
  const { protocol, hostname } = new URL(destination.origin);
  if (protocol === 'http:' && !LOOPBACK.test(hostname)) {
    return invalid('TRACE_EXPORT_ORIGIN is plain http off this machine; use https');
  }
  const key = keyFrom(value('TRACE_EXPORT_KEY_FILE'));
  if (key === undefined) {
    return invalid(
      'TRACE_EXPORT_KEY_FILE is not a file only its owner may read, holding at least 32 bytes as hex',
    );
  }
  return {
    kind: 'on',
    destination,
    credentialsFile: value('TRACE_EXPORT_CREDENTIALS_FILE'),
    key,
  };
}

/**
 * The trace key: hex, at least 32 bytes, in a file no group or other may
 * read. Opened once, so the mode checked is the file read.
 */
function keyFrom(file: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, 'r');
    if ((fstatSync(descriptor).mode & 0o077) !== 0) return undefined;
    const text = readFileSync(descriptor, 'utf8').trim();
    return /^(?:[0-9a-f]{2}){32,}$/u.test(text) ? Buffer.from(text, 'hex') : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * The trace destination as custody lists it: the origin, the fixed header,
 * and the two routes beyond the export's POST that retention needs.
 */
export function traceDestination(origin: string): Destination {
  return {
    key: TRACE_DESTINATION,
    origin,
    headers: TRACE_HEADERS,
    routes: [
      { method: 'DELETE', path: TRACE_EXPIRY_PATH },
      { method: 'GET', path: `${TRACE_EXPIRY_PATH}/*` },
    ],
  };
}

/** Custody's answer as the exporter and retention read it. */
function outboundOf(outcome: CustodyOutcome): Delivered {
  if (outcome.kind === 'answered') return outcome.outbound;
  return { ok: false, fault: outcome.kind === 'refused' ? 'forbidden' : 'network', status: null };
}

/** Delivery through custody's egress to the one trace destination. */
export function deliverThrough(custody: Custody, timeoutMs = 5_000): Deliver {
  return async (body) =>
    outboundOf(
      await custody.dispatch(TRACE_CREDENTIAL, {
        destination: TRACE_DESTINATION,
        path: TRACE_PATH,
        method: 'POST',
        body,
        timeoutMs,
        maxResponseBytes: 4_096,
      }),
    );
}

/**
 * Retention's delete and read-back through the same custody. A read that
 * answers 404 is the one proof of absence; any 2xx, even one too large to
 * read whole, is a trace still there; anything else proves nothing.
 */
export function expiryThrough(custody: Custody, timeoutMs = 5_000): ExpiryPorts {
  const ask = async (method: 'DELETE' | 'GET', path: string, body: string): Promise<Delivered> =>
    outboundOf(
      await custody.dispatch(TRACE_CREDENTIAL, {
        destination: TRACE_DESTINATION,
        path,
        method,
        body,
        timeoutMs,
        maxResponseBytes: 4_096,
      }),
    );
  return {
    expire: async (traceIds) =>
      await ask('DELETE', TRACE_EXPIRY_PATH, JSON.stringify({ traceIds })),
    present: async (traceId) => {
      const read = await ask('GET', `${TRACE_EXPIRY_PATH}/${traceId}`, '');
      if (read.status === 404) return 'absent';
      return read.status !== null && read.status >= 200 && read.status < 300
        ? 'present'
        : 'unknown';
    },
  };
}

/** One tick: every business until caught up, a gap, or its batch allowance. */
export async function exportDeployment(
  database: TraceDatabase,
  businesses: () => Promise<readonly string[]>,
  key: Buffer,
  deliver: Deliver,
): Promise<void> {
  for (const businessId of await businesses()) {
    for (let batch = 0; batch < BATCHES_PER_TICK; batch += 1) {
      // eslint-disable-next-line no-await-in-loop -- one batch after another, in order
      const outcome = await exportOnce(database, businessId, key, deliver);
      if (outcome.kind !== 'delivered') break;
    }
  }
}

/** One retention pass over every business; one business's failure does not stop the next. */
export async function retainDeployment(
  database: TraceDatabase,
  businesses: () => Promise<readonly string[]>,
  key: Buffer,
  ports: ExpiryPorts,
): Promise<void> {
  for (const businessId of await businesses()) {
    // eslint-disable-next-line no-await-in-loop -- one business after another
    await expireOnce(database, businessId, key, ports);
  }
}

/** A job on an interval that never overlaps itself and logs a failure by its kind only. */
function every(ms: number, what: string, job: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void job()
      .catch((cause: unknown) => {
        // The kind only: a database error's text can carry a value.
        console.error(`api: ${what} failed: ${cause instanceof Error ? cause.name : 'unknown'}`);
      })
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  return timer;
}

/** Custody's own process for the target, started, and the export and retention intervals over it. */
export async function startTraceExporter(
  settings: Extract<TraceExportSettings, { kind: 'on' }>,
  database: TraceDatabase,
  businesses: () => Promise<readonly string[]>,
  everyMs: number = EVERY_MS,
): Promise<{ readonly stop: () => Promise<void> }> {
  const custody = await startCustody({
    credentialsFile: settings.credentialsFile,
    destinations: [settings.destination],
  });
  const deliver = deliverThrough(custody);
  const ports = expiryThrough(custody);
  const timers = [
    every(everyMs, 'trace export', async () => {
      await exportDeployment(database, businesses, settings.key, deliver);
    }),
    every(RETAIN_EVERY_MS, 'trace retention', async () => {
      await retainDeployment(database, businesses, settings.key, ports);
    }),
  ];
  return {
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      await custody.stop();
    },
  };
}
