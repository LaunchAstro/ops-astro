// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log's reads (MP-8-4): its first page, newest days first, in the
// reader's zone or UTC, and the earlier pages read after it. Earlier pages
// belong to the first page they continue: one for the same reader, zone and
// search that leaves off on the same day, so a floor re-read that answers the
// same first page keeps the days the reader loaded under it.

import { useRef, useState } from 'react';
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
import { describeFailure } from '../../records/submit.ts';

export const UTC = 'UTC';

/** The first page, the zone it was read in, and the search words it was read for. */
export interface LedgerRead {
  /** The grant key it was read under. */
  readonly reader: string;
  readonly zone: string;
  readonly query: string | null;
  readonly ledger: TaskLedgerResult;
}

/** The pages after the first, and the first page they continue. */
export interface Earlier {
  readonly from: LedgerRead | null;
  readonly days: readonly LedgerDayView[];
  readonly earlier: boolean;
  readonly failed: string | null;
}

export const NONE: Earlier = { from: null, days: [], earlier: false, failed: null };

// Where a first page leaves off, for one reader, zone and search: earlier pages read after
// one continue any first page that starts them the same, a floor re-read's included.
export const startOf = (read: LedgerRead | null): string | null =>
  read === null
    ? null
    : JSON.stringify([read.reader, read.zone, read.query, read.ledger.days.at(-1)?.day]);
export const continues = (from: LedgerRead | null, first: LedgerRead | null): boolean =>
  startOf(from) === startOf(first);

export const ownZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const unknownZone = (result: CallResult<unknown>): boolean =>
  isRefusal(result) && result.code === 'FIELD_VALUE_INVALID' && result.names.includes('timeZone');

/** A page's body: `query` only when there are words to search for. */
export const pageBody = (zone: string, before: string | null, query: string | null) =>
  query === null ? { timeZone: zone, before } : { timeZone: zone, before, query };

export async function readNewest(
  client: OperationsClient,
  reader: string,
  zone: string,
  query: string | null,
): Promise<CallResult<LedgerRead>> {
  const result = await client.read<TaskLedgerResult>('task.ledger', pageBody(zone, null, query));
  if (zone !== UTC && unknownZone(result)) return readNewest(client, reader, UTC, query);
  if (isRefusal(result) || isUnavailable(result)) return result;
  return { ok: true, value: { reader, zone, query, ledger: result.value } };
}

export interface EarlierDays {
  readonly more: Earlier;
  /** The first page an earlier page is on its way for. */
  readonly asking: LedgerRead | null;
  readonly loadEarlier: (from: LedgerRead, days: readonly LedgerDayView[]) => void;
}

/**
 * The pages after a first page, asked for one at a time: `Load earlier days`
 * is disabled while one is on its way. Each is kept against the first page it
 * continues, so one that arrives after the first page changed is never drawn.
 */
export function useEarlierDays(client: OperationsClient, answer: LedgerRead | null): EarlierDays {
  const [more, setMore] = useState<Earlier>(NONE);
  const [asking, setAsking] = useState<LedgerRead | null>(null);
  const current = useRef(answer);
  current.current = answer;

  const loadEarlier = (from: LedgerRead, days: readonly LedgerDayView[]): void => {
    const last = days.at(-1);
    if (last === undefined) return;
    setAsking(from);
    void (async () => {
      const result = await client.read<TaskLedgerResult>(
        'task.ledger',
        pageBody(from.zone, last.day, from.query),
      );
      setAsking((now) => (now === from ? null : now));
      setMore((now) => {
        // For a first page no longer current: dropped, and the current one's days kept.
        if (!continues(from, current.current)) return now;
        const kept = continues(now.from, from) ? now : { ...NONE, from };
        if (isRefusal(result) || isUnavailable(result)) {
          return { ...kept, failed: describeFailure(result) };
        }
        const { days: next, earlier } = result.value;
        return { from, days: [...kept.days, ...next], earlier, failed: null };
      });
    })();
  };
  return { more, asking, loadEarlier };
}
