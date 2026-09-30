// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's Work log tab: the ledger face over `task.ledger` (MP-8-4).
//
// The read groups whole days in the reader's own zone, so the zone is the
// browser's. A zone the server's database does not know is refused naming
// `timeZone`, and the tab then reads in UTC and draws the times in UTC too:
// one zone for the grouping and the drawing, never a mix.
//
// `Load earlier days` asks for the page before the last day drawn and adds it
// below. The earlier pages belong to the first page they continue: a reload or
// a new reader starts again from the newest days, and a page that arrives for
// a first page no longer drawn is dropped rather than drawn under it.

import { useState, type ReactElement } from 'react';
import { Ledger } from '@launchastro/ui';
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
import { useRead } from '../../data/use-read.ts';
import { describeFailure } from '../../records/submit.ts';
import { RecordState } from '../../views/record-state.tsx';
import { pathTo } from '../../routes.ts';

const UTC = 'UTC';

/** The first page and the zone it was read in. */
interface LedgerRead {
  readonly zone: string;
  readonly ledger: TaskLedgerResult;
}

/** The pages after the first, and the first page they continue. */
interface Earlier {
  readonly from: LedgerRead | null;
  readonly days: readonly LedgerDayView[];
  readonly earlier: boolean;
  readonly failed: string | null;
}

const NONE: Earlier = { from: null, days: [], earlier: false, failed: null };

const ownZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `YYYY-MM-DD` now, in `zone`. */
const todayIn = (zone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const unknownZone = (result: CallResult<unknown>): boolean =>
  isRefusal(result) && result.code === 'FIELD_VALUE_INVALID' && result.names.includes('timeZone');

async function readNewest(client: OperationsClient, zone: string): Promise<CallResult<LedgerRead>> {
  const result = await client.read<TaskLedgerResult>('task.ledger', {
    timeZone: zone,
    before: null,
  });
  if (zone !== UTC && unknownZone(result)) return readNewest(client, UTC);
  if (isRefusal(result) || isUnavailable(result)) return result;
  return { ok: true, value: { zone, ledger: result.value } };
}

export interface WorkLogProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly navigate: (path: string) => void;
}

export function WorkLog(props: WorkLogProps): ReactElement {
  const { client, grantKey, navigate } = props;
  const { state, reload } = useRead<LedgerRead>({
    grantKey,
    run: () => readNewest(client, ownZone()),
    deps: [],
  });
  const pages = useEarlierDays(client);
  return (
    <RecordState state={state} subject="work log" onRetry={reload}>
      {(first) => <LedgerPages first={first} pages={pages} navigate={navigate} />}
    </RecordState>
  );
}

interface EarlierDays {
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
function useEarlierDays(client: OperationsClient): EarlierDays {
  const [more, setMore] = useState<Earlier>(NONE);
  const [asking, setAsking] = useState<LedgerRead | null>(null);

  const loadEarlier = (from: LedgerRead, days: readonly LedgerDayView[]): void => {
    const last = days.at(-1);
    if (last === undefined) return;
    setAsking(from);
    void (async () => {
      const result = await client.read<TaskLedgerResult>('task.ledger', {
        timeZone: from.zone,
        before: last.day,
      });
      setAsking((now) => (now === from ? null : now));
      setMore((now) => {
        const kept = now.from === from ? now : { ...NONE, from };
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

function LedgerPages(props: {
  readonly first: LedgerRead;
  readonly pages: EarlierDays;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const { first, pages, navigate } = props;
  const continued = pages.more.from === first ? pages.more : NONE;
  const days = [...first.ledger.days, ...continued.days];
  const earlier = continued.days.length === 0 ? first.ledger.earlier : continued.earlier;
  return (
    <>
      <Ledger
        days={days}
        earlier={earlier}
        loading={pages.asking === first}
        today={todayIn(first.zone)}
        timeZone={first.zone}
        taskHref={(key) => pathTo('agency:task-detail', { key })}
        onOpenTask={(key) => {
          navigate(pathTo('agency:task-detail', { key }));
        }}
        onLoadEarlier={() => {
          pages.loadEarlier(first, days);
        }}
      />
      {continued.failed === null ? null : (
        <p className="field__error" role="alert" data-ledger-more="failed">
          The earlier days could not be read: {continued.failed}
        </p>
      )}
    </>
  );
}
