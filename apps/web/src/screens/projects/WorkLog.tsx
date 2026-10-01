// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's Work log tab: the ledger face over `task.ledger` (MP-8-4).
//
// The read groups whole days in the reader's own zone, so the zone is the
// browser's. A zone the server's database does not know is refused naming
// `timeZone`, and the tab then reads in UTC and draws the times in UTC too:
// one zone for the grouping and the drawing, never a mix.
//
// The search (`ledger-search.ts`) reads people and kinds over the days in view
// and sends its free words as the ledger's `query`, which C1's search answers;
// the box stays put while a new first page is read.
//
// `Load earlier days` asks for the page before the last day drawn and adds it
// below. The earlier pages belong to the first page they continue: a reload or
// a new reader starts again from the newest days, and a page that arrives for
// a first page no longer drawn is dropped rather than drawn under it.

import { useState, type ReactElement } from 'react';
import { Button, Empty, Ledger, SearchBox } from '@launchastro/ui';
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
import { PageTip } from '../../views/page-tip.tsx';
import { pathTo } from '../../routes.ts';
import { passing, queryOf, readingLine, readSearch, type LedgerSearch } from './ledger-search.ts';

const UTC = 'UTC';

/** The Work log's section tip (MP-9-1): a tab of the Projects page, named by that route. */
export const WORK_LOG_TIP = {
  page: 'agency:projects-board',
  id: 'work-log',
  version: 1,
  text: 'Every change to a task you can see, newest day first. Search by a name, a kind of change or any words.',
} as const;

/** The first page, the zone it was read in, and the search words it was read for. */
interface LedgerRead {
  readonly zone: string;
  readonly query: string | null;
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

/** A page's body: `query` only when there are words to search for. */
const pageBody = (zone: string, before: string | null, query: string | null) =>
  query === null ? { timeZone: zone, before } : { timeZone: zone, before, query };

async function readNewest(
  client: OperationsClient,
  zone: string,
  query: string | null,
): Promise<CallResult<LedgerRead>> {
  const result = await client.read<TaskLedgerResult>('task.ledger', pageBody(zone, null, query));
  if (zone !== UTC && unknownZone(result)) return readNewest(client, UTC, query);
  if (isRefusal(result) || isUnavailable(result)) return result;
  return { ok: true, value: { zone, query, ledger: result.value } };
}

export interface WorkLogProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly navigate: (path: string) => void;
}

/** The search's words in the address (L-01 `q`), so a reload or a shared link opens it searched. */
const typedInAddress = (): string =>
  new URLSearchParams(globalThis.location?.search ?? '').get('q') ?? '';

function writeTyped(typed: string): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const query = new URLSearchParams(here.search);
  if (typed === '') query.delete('q');
  else query.set('q', typed);
  const search = query.size === 0 ? '' : `?${query.toString()}`;
  globalThis.history.replaceState(
    globalThis.history.state,
    '',
    `${here.pathname}${search}${here.hash}`,
  );
}

export function WorkLog(props: WorkLogProps): ReactElement {
  const { client, grantKey, navigate } = props;
  const [typed, setWords] = useState(typedInAddress);
  const setTyped = (words: string): void => {
    setWords(words);
    writeTyped(words);
  };
  const [known, setKnown] = useState<readonly LedgerDayView[]>([]);
  const search = readSearch(typed, known);
  const query = queryOf(search);
  const { state, reload } = useRead<LedgerRead>({
    grantKey,
    run: async () => {
      const read = await readNewest(client, ownZone(), query);
      if (!isRefusal(read) && !isUnavailable(read)) setKnown(read.value.ledger.days);
      return read;
    },
    deps: [query],
  });
  const pages = useEarlierDays(client);
  const clear = (): void => {
    setTyped('');
  };
  return (
    <div className="act__page">
      <PageTip client={client} grantKey={grantKey} tip={WORK_LOG_TIP} />
      <div className="fieldrow act__find">
        <SearchBox
          label="Search the work log"
          placeholder="Search everything: a name, “comment”, a task, any words"
          value={typed}
          onChange={setTyped}
        />
        <Button onClick={clear}>Clear</Button>
      </div>
      <RecordState state={state} subject="work log" onRetry={reload}>
        {(first) => (
          <LedgerPages
            first={first}
            pages={pages}
            search={search}
            onClear={clear}
            navigate={navigate}
          />
        )}
      </RecordState>
    </div>
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
      const result = await client.read<TaskLedgerResult>(
        'task.ledger',
        pageBody(from.zone, last.day, from.query),
      );
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

/**
 * What the search was read as, and how many events pass of those in view.
 * No time is tracked in the ledger yet, so the count line never sums any.
 */
function SearchLines(props: {
  readonly reading: string | null;
  readonly passed: number;
  readonly inView: number;
}): ReactElement {
  return (
    <>
      {props.reading === null ? null : (
        <p className="act__read" data-ledger-read>
          {props.reading}
        </p>
      )}
      {props.inView === 0 ? null : (
        <p className="act__count" data-ledger-count>
          {`${String(props.passed)} of ${String(props.inView)} entries`}
        </p>
      )}
    </>
  );
}

function LedgerPages(props: {
  readonly first: LedgerRead;
  readonly pages: EarlierDays;
  readonly search: LedgerSearch;
  readonly onClear: () => void;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const { first, pages, search, navigate } = props;
  const continued = pages.more.from === first ? pages.more : NONE;
  const days = [...first.ledger.days, ...continued.days];
  const earlier = continued.days.length === 0 ? first.ledger.earlier : continued.earlier;
  const shown = passing(days, search);
  const passed = shown.reduce((sum, day) => sum + day.events.length, 0);
  const inView = days.reduce((sum, day) => sum + day.events.length, 0);
  const reading = readingLine(search, passed);
  return (
    <>
      <SearchLines reading={reading} passed={passed} inView={inView} />
      {reading !== null && passed === 0 ? (
        <Empty
          title="Nothing matches that."
          description="This log holds every change to a task you can see: try a name on its own."
          onClearFilters={props.onClear}
        />
      ) : (
        <Ledger
          days={shown}
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
      )}
      {continued.failed === null ? null : (
        <p className="field__error" role="alert" data-ledger-more="failed">
          The earlier days could not be read: {continued.failed}
        </p>
      )}
    </>
  );
}
