// SPDX-License-Identifier: AGPL-3.0-only
//
// The error sink (ticket S0-2; GlitchTip, decided C29-3) and how an alert
// reaches it. The boundary is this code, before the first copy (tracing
// contract 9.2): an event is built from an allowlist, the error's class, its
// in-app frames, the release and the plain words, and never the error's
// message, which may hold anything. The sink mails each event at once to the
// owner and the second operator from its own mail, so the product sends no
// mail and holds no address. A sink that is down never fails a request.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainAlert, type AlertKind, type Where } from './catalogue.ts';

export type Frame = { filename: string; function: string; lineno: number; in_app: true };

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
  readonly fault: (cause: unknown) => Promise<void>;
  /** Resolves once every event handed to the sink so far is sent or dropped. */
  readonly settled: () => Promise<void>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const FUNCTION = /^[A-Za-z_$<][\w$.<>]{0,127}$/u;
const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/u;
const RELEASE = /^[0-9a-f]{12}(?:-dirty)?$/u;

function base(level: SinkEvent['level'], alert: AlertKind, where: Where, release?: string) {
  const stamped = release !== undefined && RELEASE.test(release) ? { release } : {};
  const event = { event_id: randomUUID().replaceAll('-', ''), timestamp: Date.now() / 1000 };
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
    const [, name, location = '', lineno = '0'] = FRAME.exec(line) ?? [];
    const path = location.startsWith('file://') ? fileURLToPath(location) : location;
    const filename = relative(root, path).split(sep).join('/');
    // Only a file of ours that exists: a message can forge a frame line, never a file.
    const ours = !filename.startsWith('..') && !filename.includes('node_modules');
    if (!path.startsWith('/') || !ours || !existsSync(path)) continue;
    const fn = name !== undefined && FUNCTION.test(name) ? name : '?';
    frames.push({ filename, function: fn, lineno: Number(lineno), in_app: true });
  }
  // The sink reads frames oldest first; a stack prints newest first.
  return frames.toReversed();
}

export function errorEvent(cause: unknown, place: Place): SinkEvent {
  const error = cause instanceof Error ? cause : undefined;
  const type = error !== undefined && NAME.test(error.name) ? error.name : 'Error';
  const frames = framesOf(error?.stack ?? '', place.root);
  const value = plainAlert('app-error', place.where).text;
  return {
    ...base('error', 'app-error', place.where, place.release),
    exception: { values: [{ type, value, stacktrace: { frames } }] },
  };
}

export function alertEvent(kind: AlertKind, where: Where, release?: string): SinkEvent {
  const message = { formatted: plainAlert(kind, where).text };
  return { ...base('warning', kind, where, release), message };
}

const NOT_A_DSN = 'OPS_ERROR_SINK_DSN is not a DSN (https://<key>@<host>/<project>).';

/**
 * The sink's store endpoint, from its DSN. The key travels in the auth header
 * only; a malformed DSN is refused by the setting's name, never echoed.
 */
export function dsnTransport(dsn: string, fetcher: typeof fetch = fetch): Transport {
  const url = URL.parse(dsn);
  const project = url?.pathname.replaceAll('/', '') ?? '';
  if (
    url === null ||
    !/^https?:$/u.test(url.protocol) ||
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
  return { send: dsnTransport(dsn), where, ...(release === undefined ? {} : { release }) };
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
  return {
    fault: async (cause) => await deliver(errorEvent(cause, options)),
    settled: async () => void (await Promise.all(pending)),
  };
}
