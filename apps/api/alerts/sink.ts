// SPDX-License-Identifier: AGPL-3.0-only
//
// The error sink (ticket S0-2; GlitchTip, decided C29-3) and how an alert,
// the security detections' included, reaches it. The boundary is this code,
// before the first copy (tracing contract 9.2): an event is built from an
// allowlist, a standard error class, the file and line of each in-app frame,
// the release and the plain words. Never the error's message, a custom class
// name or a function name, which code or a message may fill with anything,
// and building an event never throws. The sink mails each event at once to
// the owner and the second operator from its own mail, so the product sends
// no mail and holds no address. A sink that is down never fails a request.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { plainAlert, type AlertKind, type Where } from './catalogue.ts';
import { createDetector, type SecuritySignal } from './detect.ts';
// What a sink off the machine cannot be: the watcher's own rule.
import { UNREACHABLE } from '../../worker/heartbeat.ts';

export type Frame = { filename: string; lineno: number; in_app: true };

/** The sink's store event, as far as this code fills it. */
export interface SinkEvent {
  readonly event_id: string;
  readonly timestamp: number;
  readonly platform: 'node';
  readonly level: 'error' | 'warning';
  readonly environment: Where;
  readonly release?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly message?: { readonly formatted: string };
  readonly exception?: {
    values: { type: string; value: string; stacktrace: { frames: Frame[] } }[];
  };
}

export type Transport = (event: SinkEvent) => Promise<void>;

export interface Place {
  readonly where: Where;
  /** The build stamp (S0-1c); anything else is left out. */
  readonly release?: string;
  /** The checkout the server runs from: frames outside it are not ours. */
  readonly root: string;
}

export interface Alerts {
  readonly observe: (signal: SecuritySignal) => void;
  readonly fault: (cause: unknown) => Promise<void>;
  /** Resolves once every event handed to the sink so far is sent or dropped. */
  readonly settled: () => Promise<void>;
}

// The standard classes only: any other name is set by code and could carry anything.
const STANDARD = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']);
STANDARD.add('URIError').add('EvalError').add('AggregateError');
const FRAME = /^\s*at (?:.+? \()?(.+?):(\d+):\d+\)?$/u;
const RELEASE = /^[0-9a-f]{12}(?:-dirty)?$/u;

function base(
  level: SinkEvent['level'],
  alert: AlertKind,
  where: Where,
  release?: string,
  id: string = randomUUID().replaceAll('-', ''),
) {
  const stamped = release !== undefined && RELEASE.test(release) ? { release } : {};
  const event = { event_id: id, timestamp: Date.now() / 1000 };
  return {
    ...event,
    platform: 'node' as const,
    level,
    environment: where,
    ...stamped,
    tags: { alert },
  };
}

function framesOf(stack: string, root: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    // A frame is a file of ours that exists and a line number, nothing more: a message
    // can forge a frame line, never a file, and a function name is not sent at all.
    // A line that cannot be read is skipped: building the event never throws.
    try {
      const [, location = '', lineno = '0'] = FRAME.exec(line) ?? [];
      const path = location.startsWith('file://') ? fileURLToPath(location) : location;
      const filename = relative(root, path).split(sep).join('/');
      const ours = !filename.startsWith('..') && !filename.includes('node_modules');
      if (!path.startsWith('/') || !ours || !existsSync(path)) continue;
      frames.push({ filename, lineno: Number(lineno), in_app: true });
    } catch {
      continue;
    }
  }
  // The sink reads frames oldest first; a stack prints newest first.
  return frames.toReversed();
}

/** A string property of a thrown value, or empty: a getter that throws is read as nothing. */
function text(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

// A database state is logged only from the driver's error class and only from
// this fixed list of standard SQLSTATEs; a system code only from the list after
// it. The class is public, so code can make one with any code, and a function
// can raise any code: five free characters are a channel into the log, and a
// listed state carries nothing but its own meaning.
const SQLSTATE = new Set(['22001', '22003', '22P02', '23502', '23503', '23505', '23514']);
for (const code of ['25P02', '40001', '40P01', '42501', '42P01', '42703', '42883', '53300'])
  SQLSTATE.add(code);
for (const code of ['55P03', '57014', '57P01', '08000', '08001', '08003', '08006'])
  SQLSTATE.add(code);
const SYSTEM = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
SYSTEM.add('EHOSTUNREACH').add('EAI_AGAIN').add('ENOMEM').add('EMFILE');

/**
 * What the API's own log may say of a fault: a listed database state from a
 * `PostgresError`, a listed system code, else a standard error class, else
 * `unknown`. Never a custom name, a message or a constraint.
 */
export function faultCode(cause: unknown): string {
  const code = text(() => (cause as { code?: unknown } | undefined)?.code);
  if (cause instanceof postgres.PostgresError && SQLSTATE.has(code)) return code;
  if (SYSTEM.has(code)) return code;
  const name = cause instanceof Error ? text(() => cause.name) : '';
  return STANDARD.has(name) ? name : 'unknown';
}

export function errorEvent(cause: unknown, place: Place): SinkEvent {
  const error = cause instanceof Error ? cause : undefined;
  const name = text(() => error?.name);
  const type = STANDARD.has(name) ? name : 'Error';
  const frames = framesOf(
    text(() => error?.stack),
    place.root,
  );
  const value = plainAlert('app-error', place.where).text;
  return {
    ...base('error', 'app-error', place.where, place.release),
    exception: { values: [{ type, value, stacktrace: { frames } }] },
  };
}

type Stored = { readonly exception?: { readonly values?: unknown } };

/**
 * An error row of the outbox (0047), rebuilt for the sink as `errorEvent`
 * builds one: a standard class, the fixed words and the frames that name a
 * file of this checkout, no more. A row is written by the application group,
 * so whatever else it holds (a message, a tag, a custom class, a release) is
 * not sent: the release is the forwarder's own stamp, and `id` the caller's,
 * fixed by the row so a retried send is the same event.
 */
export function rebuiltError(stored: unknown, place: Place, id?: string): SinkEvent {
  const event: Stored = typeof stored === 'object' && stored !== null ? stored : {};
  const values = event.exception?.values;
  const thrown = (Array.isArray(values) ? values[0] : undefined) as
    { type?: unknown; stacktrace?: { frames?: unknown } } | undefined;
  const type =
    typeof thrown?.type === 'string' && STANDARD.has(thrown.type) ? thrown.type : 'Error';
  const listed = thrown?.stacktrace?.frames;
  const frames = (Array.isArray(listed) ? listed : []).flatMap((frame: unknown): Frame[] => {
    const { filename, lineno } = (frame ?? {}) as { filename?: unknown; lineno?: unknown };
    if (typeof filename !== 'string' || typeof lineno !== 'number') return [];
    const ours =
      !filename.startsWith('/') &&
      !filename.split('/').includes('..') &&
      !filename.includes('node_modules') &&
      existsSync(join(place.root, filename));
    return ours && Number.isInteger(lineno) && lineno > 0
      ? [{ filename, lineno, in_app: true }]
      : [];
  });
  const value = plainAlert('app-error', place.where).text;
  return {
    ...base('error', 'app-error', place.where, place.release, id),
    exception: { values: [{ type, value, stacktrace: { frames } }] },
  };
}

export function alertEvent(
  kind: AlertKind,
  where: Where,
  release?: string,
  id?: string,
): SinkEvent {
  const message = { formatted: plainAlert(kind, where).text };
  return { ...base('warning', kind, where, release, id), message };
}

const NOT_A_DSN =
  'OPS_ERROR_SINK_DSN is not a DSN at a public https address (https://<key>@<host>/<project>).';

/**
 * The sink's store endpoint, from its DSN. The key travels in the auth header
 * only, over https, to a public address, and never after a redirect; a
 * malformed or private DSN is refused by the setting's name, never echoed.
 */
export function dsnTransport(dsn: string, fetcher: typeof fetch = fetch): Transport {
  const url = URL.parse(dsn);
  const project = url?.pathname.replaceAll('/', '') ?? '';
  if (
    url === null ||
    url.protocol !== 'https:' ||
    UNREACHABLE.test(url.hostname) ||
    url.username === '' ||
    !/^\d+$/u.test(project)
  ) {
    throw new Error(NOT_A_DSN);
  }
  const store = `${url.protocol}//${url.host}/api/${project}/store/`;
  const auth = `Sentry sentry_version=7, sentry_client=ops-astro/1, sentry_key=${url.username}`;
  return async (event) => {
    const response = await fetcher(store, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sentry-auth': auth },
      body: JSON.stringify(event),
      redirect: 'manual',
      // A hung sink is a sink that is down: give up, the watcher reports it.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the error sink answered ${response.status}`);
  };
}

/**
 * The sink named by `OPS_ERROR_SINK_DSN`, `OPS_ENVIRONMENT` and `OPS_RELEASE`
 * (deploy/staging/README.md); none without a DSN. A problem names the setting.
 */
export function sinkFrom(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly send: Transport; readonly where: Where; readonly release?: string } | undefined {
  const dsn = environment['OPS_ERROR_SINK_DSN'];
  if (dsn === undefined || dsn === '') return undefined;
  const where = environment['OPS_ENVIRONMENT'];
  if (where !== 'staging' && where !== 'production') {
    throw new Error('OPS_ENVIRONMENT must be staging or production.');
  }
  const release = environment['OPS_RELEASE'];
  if (release !== undefined && release !== '' && !RELEASE.test(release)) {
    throw new Error('OPS_RELEASE is not a build stamp (twelve hex digits, optionally -dirty).');
  }
  return { send: dsnTransport(dsn), where, ...(release ? { release } : {}) };
}

export function createAlerts(options: Place & { readonly send: Transport }): Alerts {
  const pending = new Set<Promise<void>>();
  function deliver(event: SinkEvent): Promise<void> {
    const sent = options.send(event).catch(() => {
      console.error('alerts: the error sink did not take an event; the watcher reports the sink.');
    });
    pending.add(sent);
    void sent.finally(() => pending.delete(sent));
    return sent;
  }
  // A raised detection is its kind alone: it cannot name the scope that raised it.
  const detector = createDetector((kind) => {
    void deliver(alertEvent(kind, options.where, options.release));
  });
  return {
    observe: detector.observe,
    fault: async (cause) => await deliver(errorEvent(cause, options)),
    settled: async () => void (await Promise.all(pending)),
  };
}
