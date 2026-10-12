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
// the box stays put while a new first page is read. A name is a person once the
// reader has seen them act on any page read here, earlier days included, so a
// new answer cannot turn a person back into a word (`work-log-typed.ts`).
//
// No topic reaches the ledger, so it re-reads on the tab's rollup floor (C4
// CS-1.2): every day loaded, as one window (`work-log-window.ts`). A refusal or
// an outage on any page withdraws every drawn day. `Load earlier days` asks for
// the page before the last day drawn and adds it below; a new reader or search
// starts again from the newest days.

import { useRef, useState, type ReactElement } from 'react';
import { Button, Ledger, SearchBox } from '@launchastro/ui';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import { useRead, type UseReadLive } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { PageTip } from '../../views/page-tip.tsx';
import { pathTo } from '../../routes.ts';
import { passing, queryOf, readingLine, readSearch, type LedgerSearch } from './ledger-search.ts';
import { usePeopleSeen, useTyped } from './work-log-typed.ts';
import { NoMatch, SearchLines } from './work-log-lines.tsx';
import {
  extend,
  joins,
  readPage,
  readWindow,
  type Asking,
  type LedgerRead,
} from './work-log-window.ts';

/** The Work log's section tip (MP-9-1): a tab of the Projects page, named by that route. */
export const WORK_LOG_TIP = {
  page: 'agency:projects-board',
  id: 'work-log',
  version: 1,
  text: 'Every change to a task you can see, newest day first. Search by a name, a kind of change or any words.',
} as const;

const ownZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `YYYY-MM-DD` now, in `zone`. */
const todayIn = (zone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export interface WorkLogProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly navigate: (path: string) => void;
  /** A dock panel's own address, which holds its search instead of the page's. */
  readonly address?: string | undefined;
  readonly inPanel?: boolean;
}

export function WorkLog(props: WorkLogProps): ReactElement {
  const { client, grantKey, navigate } = props;
  const [typed, setTyped] = useTyped(props.address, props.inPanel === true);
  // The first page the read last accepted. An answer the read dropped names
  // nobody, and a page's searched words stay words, never its people.
  const [answer, setAnswer] = useState<LedgerRead | null>(null);
  const people = usePeopleSeen(grantKey);
  const search = readSearch(typed, people.names, answer?.query ?? null);
  const query = queryOf(search);
  const log = useWindow(client, grantKey, query);
  const { state, reload } = log.read;
  const accepted = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  if (accepted !== null && accepted !== answer) setAnswer(accepted);
  const pages = useEarlierDays(client, log);
  // Only this reader's: `accepted` is always the current grant's read.
  if (accepted !== null) people.see(accepted.ledger.days);
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
      <RecordState state={state} subject="work log" onRetry={reload} keep>
        {(loaded) => (
          <LedgerPages
            loaded={loaded}
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

interface WindowRead {
  readonly read: UseReadLive<LedgerRead>;
  readonly epoch: number;
  /** The oldest day loaded, which a refresh reads down to. */
  readonly through: { current: string | null };
}

/** The window, re-read on the tab's floor one run at a time. */
function useWindow(client: OperationsClient, grantKey: string, query: string | null): WindowRead {
  const through = useRef<string | null>(null);
  const read = useRead<LedgerRead>({
    grantKey,
    run: () => readWindow(client, ownZone(), query, through.current),
    deps: [query],
    rollup: tabRollupFloor(),
    coalesce: true,
  });
  return { read, epoch: useEpoch(grantKey, query, read.state, through), through };
}

/**
 * The window's epoch: a new reader or search starts another, and sends the
 * window back to its first page; a refusal or an outage starts another too, so
 * nothing sent before it joins what is drawn after.
 */
function useEpoch(
  grantKey: string,
  query: string | null,
  state: ReadState<LedgerRead>,
  through: { current: string | null },
): number {
  const seen = useRef({ grantKey, query, failure: null as ReadState<LedgerRead> | null, epoch: 0 });
  const last = seen.current;
  const failure = state.outcome === 'denied' || state.outcome === 'unavailable' ? state : null;
  const reset = last.grantKey !== grantKey || last.query !== query;
  if (reset) through.current = null;
  if (reset || (failure !== null && failure !== last.failure)) {
    seen.current = { grantKey, query, failure: failure ?? last.failure, epoch: last.epoch + 1 };
  }
  return seen.current.epoch;
}

interface EarlierDays {
  /** Whether an earlier page is on its way for the window drawn now. */
  readonly loading: boolean;
  readonly loadEarlier: (from: LedgerRead) => Promise<void>;
}

/**
 * The page before the window, one at a time: `Load earlier days` is disabled
 * while one is on its way, whatever a refresh does. A failure withdraws the
 * window as a refresh's would, and retires the refresh in flight. A page joins
 * only the window it left from; one that joins while a refresh is in flight
 * starts the refresh again, since that one reads only the days before it.
 */
function useEarlierDays(client: OperationsClient, log: WindowRead): EarlierDays {
  const [asking, setAsking] = useState<Asking | null>(null);
  const { read, epoch, through } = log;
  const now = useRef({ epoch, state: read.state });
  now.current = { epoch, state: read.state };

  const loadEarlier = async (from: LedgerRead): Promise<void> => {
    const boundary = from.ledger.days.at(-1)?.day;
    if (boundary === undefined) return;
    const sent: Asking = { epoch, zone: from.zone, boundary };
    setAsking(sent);
    const result = await readPage(client, from.zone, boundary, from.query);
    setAsking((held) => (held === sent ? null : held));
    const current = now.current;
    if (isRefusal(result) || isUnavailable(result)) {
      if (sent.epoch === current.epoch) read.land(result);
      return;
    }
    const drawn = drawnOf(current.state);
    if (drawn === null || !joins(sent, current.epoch, drawn)) return;
    through.current = result.value.days.at(-1)?.day ?? through.current;
    read.land({ ok: true, value: extend(drawn, result.value) });
    if (current.state.outcome === 'loading') read.reload();
  };
  return { loading: asking?.epoch === epoch, loadEarlier };
}

/** The window on screen: the answer, or the one kept while its refresh is in flight. */
const drawnOf = (state: ReadState<LedgerRead>): LedgerRead | null =>
  state.outcome === 'loading' ? state.previous : state.value;

function LedgerPages(props: {
  readonly loaded: LedgerRead;
  readonly pages: EarlierDays;
  readonly search: LedgerSearch;
  readonly onClear: () => void;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const { loaded, pages, search, navigate } = props;
  const { days, earlier } = loaded.ledger;
  const shown = passing(days, search);
  const passed = shown.reduce((sum, day) => sum + day.events.length, 0);
  const inView = days.reduce((sum, day) => sum + day.events.length, 0);
  const reading = readingLine(search, passed);
  const partial = loaded.query !== null && loaded.ledger.more === true;
  const loading = pages.loading;
  const loadEarlier = (): void => {
    if (!loading) void pages.loadEarlier(loaded);
  };
  return (
    <>
      <SearchLines reading={reading} passed={passed} inView={inView} partial={partial} />
      {reading !== null && passed === 0 ? (
        <NoMatch
          earlier={earlier}
          loading={loading}
          onClear={props.onClear}
          onLoadEarlier={loadEarlier}
        />
      ) : (
        <Ledger
          days={shown}
          earlier={earlier}
          loading={loading}
          today={todayIn(loaded.zone)}
          timeZone={loaded.zone}
          taskHref={(key) => pathTo('agency:task-detail', { key })}
          onOpenTask={(key) => {
            navigate(pathTo('agency:task-detail', { key }));
          }}
          onLoadEarlier={loadEarlier}
        />
      )}
    </>
  );
}
