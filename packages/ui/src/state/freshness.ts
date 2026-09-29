// SPDX-License-Identifier: AGPL-3.0-only
//
// C4, CS-1.1: what the page header's freshness marker says.
//
// The marker is an indicator, never a control (docs/design-system/research/
// LIVE-SYNC.md, "What the freshness marker shows"). This decides which of its
// five states is honest now and the values its words carry; the kit's
// `FreshnessMarker` (DS-PRIM-25) draws them. `Freshness` restates the kit's
// type until the kit lands here, and is replaced by it then.
//
// The order is the table's, read as "never green over a failure": a refused
// re-read claims nothing (the page draws its own denied state), and so does a
// page not yet read; a frozen page is frozen by design; our own connection
// comes before a provider's, because data we cannot refresh is not current
// whatever its source says; and live is left for when nothing else holds.

export type Freshness =
  | { readonly state: 'live'; readonly age: string }
  | { readonly state: 'catching-up'; readonly lastRead: string }
  | { readonly state: 'offline'; readonly lastRead: string }
  | {
      readonly state: 'source-behind';
      readonly source: string;
      readonly lastGood: string;
      readonly href: string;
    }
  | { readonly state: 'frozen'; readonly at: string };

/** What the page knows about its own liveness. Times are epoch milliseconds. */
export interface LiveStatus {
  /** The last re-read was refused: a grant went. */
  readonly denied: boolean;
  /** When the page was frozen by design (a closed weekly report), or null. */
  readonly frozenAt: number | null;
  /** The browser's own word. */
  readonly online: boolean;
  /** When the stream dropped, or null while it is open. */
  readonly streamDownSince: number | null;
  /** When reads began failing (not refused), or null while they succeed. */
  readonly failingSince: number | null;
  /** The last read that succeeded, or null before the first. */
  readonly lastReadAt: number | null;
  /** The newest change in scope, or null when there is none. */
  readonly changedAt: number | null;
  /** A provider source the page's figures come from, or null for records. */
  readonly source: {
    readonly name: string;
    readonly lastGood: number;
    readonly href: string;
    /** Past its own cadence, or its last pull failed. */
    readonly behind: boolean;
  } | null;
}

/**
 * How long reads may fail before the page says Offline. The table's 30 s:
 * the floor a page re-reads on when the stream cannot reach it.
 */
export const GRACE_MS = 30_000;

export function freshnessOf(status: LiveStatus, now: number, timeZone: string): Freshness | null {
  const read = status.lastReadAt;
  if (status.denied || read === null) return null;
  if (status.frozenAt !== null)
    return { state: 'frozen', at: dayAndTime(status.frozenAt, timeZone) };
  const lastRead = clock(read, now, timeZone);
  const failedPastGrace = status.failingSince !== null && now - status.failingSince >= GRACE_MS;
  if (!status.online || failedPastGrace) return { state: 'offline', lastRead };
  if (status.streamDownSince !== null || status.failingSince !== null) {
    return { state: 'catching-up', lastRead };
  }
  const source = status.source;
  if (source?.behind === true) {
    return {
      state: 'source-behind',
      source: source.name,
      lastGood: clock(source.lastGood, now, timeZone),
      href: source.href,
    };
  }
  return { state: 'live', age: ago(now - (status.changedAt ?? read)) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))} min ago`;
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))} h ago`;
  const days = Math.floor(ms / DAY);
  return days === 1 ? '1 day ago' : `${String(days)} days ago`;
}

const parts = (ms: number, timeZone: string, options: Intl.DateTimeFormatOptions) =>
  new Map(
    new Intl.DateTimeFormat('en-AU', { timeZone, ...options })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );

// The mockup's three-letter months; ICU's own short form varies by version
// ("Sep", "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dayOf = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(ms);

/** `10:42` on the reader's today, `28 Sep 06:10` on any other day. */
function clock(ms: number, now: number, timeZone: string): string {
  const p = parts(ms, timeZone, {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const time = `${p.get('hour') ?? ''}:${p.get('minute') ?? ''}`;
  return dayOf(ms, timeZone) === dayOf(now, timeZone)
    ? time
    : `${p.get('day') ?? ''} ${MONTHS[Number(p.get('month')) - 1] ?? ''} ${time}`;
}

/** `Sunday 6:10am`, as the mockup dates a frozen page. */
function dayAndTime(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const half = (p.get('dayPeriod') ?? '').toLowerCase();
  return `${p.get('weekday') ?? ''} ${p.get('hour') ?? ''}:${p.get('minute') ?? ''}${half}`;
}
