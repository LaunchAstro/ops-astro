// SPDX-License-Identifier: AGPL-3.0-only
//
// The service-health section of the operations view (C34, CS-2.16): the
// installation's watcher, its error sink and, where switched on, tracing, as
// the holder of `operations:read` is shown them.
//
// Four states are kept apart, because each asks something different of the
// reader. A service never observed has no reading yet; a stale one has not
// been seen lately, so its last reading says nothing about now; a service
// failure is a source saying the service is down; and a read failure is the
// source itself not answering, which says nothing about its services at all.
// An optional source switched off is "off", never a failure.
//
// A source is distrusted until its answer is shaped: each is read under a
// time limit, a thrown error or an answer of the wrong shape is a read
// failure by kind, and nothing a source says is shown unless the whole answer
// holds. A client's own site is that client's (C24), never the installation's,
// so it is never shown here.
//
// The sources are called by the API after the grant check and outside any
// transaction (`apps/api/app.ts`), so a refused caller asks no source.

import type {
  HealthFault,
  HealthSourceName,
  HealthSourceView,
  ServiceHealthSection,
  ServiceHealthState,
  ServiceHealthView,
} from '../../../core-wire/src/index.ts';

/** One service as a source reports it. */
export interface ServiceObservation {
  readonly name: string;
  /** A client's own site is that client's, never the installation's (C24). */
  readonly scope: 'installation' | 'client-site';
  /** Up or down at the last check, or null when never checked. */
  readonly up: boolean | null;
  readonly observedAt: Date | null;
}

export type SourceAnswer =
  | { readonly ok: true; readonly services: readonly ServiceObservation[] }
  | { readonly ok: false; readonly fault: Exclude<HealthFault, 'unconfigured'> };

/** A watcher, an error sink or the tracing service, as the operations view reads it. */
export interface HealthSource {
  observe(): Promise<SourceAnswer>;
}

/** The installation's sources. An absent `tracing` is switched off. */
export interface HealthSources {
  readonly watcher?: HealthSource;
  readonly errorSink?: HealthSource;
  readonly tracing?: HealthSource;
  /** Milliseconds each source has to answer. */
  readonly timeoutMs?: number;
}

/** A service last seen longer ago than this is stale: three of the watcher's five-minute checks. */
export const HEALTH_STALE_SECONDS: number = 15 * 60;

const DEFAULT_TIMEOUT_MS = 3000;
const MOST_SERVICES = 200;
const NAME_LIMIT = 200;
/** The clock drift an observation time may show ahead of this server's. */
const CLOCK_ALLOWANCE_MS = 60_000;
const FAULTS: ReadonlySet<string> = new Set([
  'refused',
  'malformed',
  'oversized',
  'slow',
  'unreachable',
]);

interface Reading {
  readonly view: HealthSourceView;
  readonly services: readonly ServiceHealthView[];
}

/** The section: each source read at once, under its own time limit. */
export async function readServiceHealth(
  sources: HealthSources,
  now: Date,
): Promise<ServiceHealthSection> {
  const timeoutMs = sources.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const named: readonly (readonly [HealthSourceName, HealthSource | undefined])[] = [
    ['watcher', sources.watcher],
    ['error-sink', sources.errorSink],
    ['tracing', sources.tracing],
  ];
  const readings = await Promise.all(
    named.map(async ([name, source]) => await readSource(name, source, now, timeoutMs)),
  );
  return {
    checkedAt: now.toISOString(),
    sources: readings.map((reading) => reading.view),
    services: readings.flatMap((reading) => reading.services),
  };
}

async function readSource(
  name: HealthSourceName,
  source: HealthSource | undefined,
  now: Date,
  timeoutMs: number,
): Promise<Reading> {
  if (source === undefined) {
    // Tracing is optional; the watcher and the error sink are not.
    return name === 'tracing'
      ? { view: { source: name, state: 'off', fault: null }, services: [] }
      : failed(name, 'unconfigured');
  }
  const answer = await observeWithin(source, timeoutMs);
  if (!answer.ok) return failed(name, answer.fault);
  const services = shaped(answer.services, now);
  if (services === undefined) return failed(name, 'malformed');
  return {
    view: { source: name, state: 'read', fault: null },
    services: services
      .filter((service) => service.scope === 'installation')
      .map((service) => ({
        source: name,
        name: service.name,
        state: stateOf(service, now),
        lastObservedAt: service.observedAt?.toISOString() ?? null,
      })),
  };
}

function failed(name: HealthSourceName, fault: HealthFault): Reading {
  return { view: { source: name, state: 'read-failure', fault }, services: [] };
}

/** The source's answer, or its fault by kind; a throw is `unreachable`, no answer in time `slow`. */
async function observeWithin(source: HealthSource, timeoutMs: number): Promise<SourceAnswer> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<SourceAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, fault: 'slow' }), timeoutMs);
    timer.unref();
  });
  try {
    const answer: unknown = await Promise.race([source.observe(), late]);
    return isAnswer(answer) ? answer : { ok: false, fault: 'malformed' };
  } catch {
    // The error's words go nowhere: they are the source's, and could be anything.
    return { ok: false, fault: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function isAnswer(value: unknown): value is SourceAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as Readonly<Record<string, unknown>>;
  if (answer['ok'] === true) return Array.isArray(answer['services']);
  return (
    answer['ok'] === false && typeof answer['fault'] === 'string' && FAULTS.has(answer['fault'])
  );
}

/** Every observation shaped, or none: a source is shown whole or not at all. */
function shaped(
  services: readonly unknown[],
  now: Date,
): readonly ServiceObservation[] | undefined {
  if (services.length > MOST_SERVICES) return undefined;
  return services.every((service) => isObservation(service, now))
    ? (services as readonly ServiceObservation[])
    : undefined;
}

function isObservation(value: unknown, now: Date): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { name, scope, up, observedAt } = value as Readonly<Record<string, unknown>>;
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= NAME_LIMIT &&
    // No control characters: a name is shown as text, on one line.
    [...name].every((char) => char >= ' ' && char !== '\u007F') &&
    (scope === 'installation' || scope === 'client-site') &&
    (up === null || typeof up === 'boolean') &&
    (observedAt === null ||
      (observedAt instanceof Date &&
        !Number.isNaN(observedAt.getTime()) &&
        observedAt.getTime() <= now.getTime() + CLOCK_ALLOWANCE_MS))
  );
}

function stateOf(service: ServiceObservation, now: Date): ServiceHealthState {
  if (service.observedAt === null || service.up === null) return 'never-observed';
  if (now.getTime() - service.observedAt.getTime() > HEALTH_STALE_SECONDS * 1000) return 'stale';
  return service.up ? 'healthy' : 'service-failure';
}
