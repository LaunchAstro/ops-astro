// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log's window: every day the reader has loaded, read as one answer.
//
// A refresh re-reads the whole window, the first page and then each page
// before it down to the oldest day loaded (`through`), so a refusal on any
// page withdraws every drawn day and a deleted task's events leave the earlier
// days too. The chain stops at the first failure, and gives up without an
// answer when the tab is hidden before a page. Each of its pages has twenty
// seconds, so a refresh always ends and the floor's next one can start.
//
// `Load earlier days` sends one page beyond the window. It joins only the
// window it left from: the same epoch (no new reader, zone or search, and no
// failure since) and the same last day.

import type {
  LedgerDayView,
  TaskLedgerResult,
} from '../../../../../packages/core-wire/src/index.ts';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../../operations/client.ts';
import { RETIRED } from '../../data/use-read.ts';

const UTC = 'UTC';

/** How long one page is waited for before the window fails as unavailable. */
export const PAGE_MS = 20_000;

/** The window: the zone it was read in, the search words, and every day loaded. */
export interface LedgerRead {
  readonly zone: string;
  readonly query: string | null;
  readonly ledger: TaskLedgerResult;
}

/** Where the window stands: a new reader or search, or a failure, moves it on. */
export interface Since {
  readonly epoch: number;
  readonly failures: number;
}

/** An earlier page on its way: the window it left from, and the day it reads before. */
export interface Asking extends Since {
  readonly zone: string;
  readonly boundary: string;
}

/** A page's body: `query` only when there are words to search for. */
const pageBody = (zone: string, before: string | null, query: string | null) =>
  query === null ? { timeZone: zone, before } : { timeZone: zone, before, query };

const failed = (
  result: CallResult<TaskLedgerResult>,
): result is Exclude<CallResult<TaskLedgerResult>, { ok: true }> =>
  isRefusal(result) || isUnavailable(result);

const unknownZone = (result: CallResult<unknown>): boolean =>
  isRefusal(result) && result.code === 'FIELD_VALUE_INVALID' && result.names.includes('timeZone');

const lastDay = (days: readonly LedgerDayView[]): string | undefined => days.at(-1)?.day;

/** One page of the ledger: the days before `before` (null: the newest). */
export const readPage = (
  client: OperationsClient,
  zone: string,
  before: string | null,
  query: string | null,
): Promise<CallResult<TaskLedgerResult>> =>
  client.read<TaskLedgerResult>('task.ledger', pageBody(zone, before, query));

/** A page of the window, failing as unavailable after `PAGE_MS`. */
async function timed(
  read: Promise<CallResult<TaskLedgerResult>>,
): Promise<CallResult<TaskLedgerResult>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CallResult<TaskLedgerResult>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ unavailable: true, because: 'The work log took too long to answer.' });
    }, PAGE_MS);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

const hidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Read the window down to `through`, the oldest day loaded (null: the first
 * page alone). A zone the server does not know reads in UTC instead.
 */
export async function readWindow(
  client: OperationsClient,
  zone: string,
  query: string | null,
  through: string | null,
): Promise<CallResult<LedgerRead> | typeof RETIRED> {
  if (hidden()) return RETIRED;
  const first = await timed(readPage(client, zone, null, query));
  if (zone !== UTC && unknownZone(first)) return readWindow(client, UTC, query, through);
  if (failed(first)) return first;
  const days = [...first.value.days];
  let { earlier } = first.value;
  while (earlier) {
    const last = lastDay(days);
    if (through === null || last === undefined || last <= through) break;
    if (hidden()) return RETIRED;
    // oxlint-disable-next-line no-await-in-loop -- each page reads before the last one's days
    const page = await timed(readPage(client, zone, last, query));
    if (failed(page)) return page;
    days.push(...page.value.days);
    earlier = page.value.earlier && page.value.days.length > 0;
  }
  return { ok: true, value: { zone, query, ledger: { ...first.value, days, earlier } } };
}

/** Whether an earlier page that left as `asking` may join `drawn`, the window now at `since`. */
export const joins = (asking: Asking, since: Since, drawn: LedgerRead): boolean =>
  asking.epoch === since.epoch &&
  asking.failures === since.failures &&
  drawn.zone === asking.zone &&
  lastDay(drawn.ledger.days) === asking.boundary;

/** `drawn` with an earlier page's days below its own. */
export const extend = (drawn: LedgerRead, page: TaskLedgerResult): LedgerRead => ({
  ...drawn,
  ledger: { ...drawn.ledger, days: [...drawn.ledger.days, ...page.days], earlier: page.earlier },
});
