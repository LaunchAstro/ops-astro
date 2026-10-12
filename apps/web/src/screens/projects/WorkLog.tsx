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
// the box stays put while a new first page is read. No topic reaches the
// ledger, so it re-reads on the tab's floor (LIVE-SYNC.md): a grant revoked
// elsewhere shows on the next re-read, not after a reload.
//
// `Load earlier days` asks for the page before the last day drawn and adds it
// below. The earlier pages belong to the first page they continue: a reload or
// a new reader starts again from the newest days, and a page that arrives for
// a first page no longer drawn is dropped rather than drawn under it.

import { useState, type ReactElement } from 'react';
import { Button, Empty, Ledger, SearchBox } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { PageTip } from '../../views/page-tip.tsx';
import { pathTo } from '../../routes.ts';
import { passing, queryOf, readingLine, readSearch, type LedgerSearch } from './ledger-search.ts';
import {
  continues,
  NONE,
  ownZone,
  readNewest,
  useEarlierDays,
  type EarlierDays,
  type LedgerRead,
} from './work-log-reads.ts';

/** The Work log's section tip (MP-9-1): a tab of the Projects page, named by that route. */
export const WORK_LOG_TIP = {
  page: 'agency:projects-board',
  id: 'work-log',
  version: 1,
  text: 'Every change to a task you can see, newest day first. Search by a name, a kind of change or any words.',
} as const;

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
  // The first page the read last accepted. The people in view are read from
  // it alone: an answer the read dropped names nobody, and the words it was
  // searched for stay words, so its own answer cannot turn them into people.
  const [answer, setAnswer] = useState<LedgerRead | null>(null);
  const search = readSearch(typed, answer?.ledger.days ?? [], answer?.query ?? null);
  const query = queryOf(search);
  const { state, reload } = useRead<LedgerRead>({
    grantKey,
    run: () => readNewest(client, grantKey, ownZone(), query),
    deps: [query],
    rollup: tabRollupFloor(),
  });
  const accepted = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  if (accepted !== null && accepted !== answer) setAnswer(accepted);
  const pages = useEarlierDays(client, answer);
  const clear = (): void => setTyped('');
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

/**
 * What the search was read as, and how many events pass of those in view.
 * No time is tracked in the ledger yet, so the count line never sums any.
 * `partial`: the search's matches go past what it reads (C1's bound, 500),
 * so some are not listed and the count says so.
 */
function SearchLines(props: {
  readonly reading: string | null;
  readonly passed: number;
  readonly inView: number;
  readonly partial: boolean;
}): ReactElement {
  return (
    <>
      {props.reading === null ? null : (
        <p className="act__read" data-ledger-read>
          {props.reading}
        </p>
      )}
      {props.inView === 0 ? null : (
        <p
          className="act__count"
          data-ledger-count
          data-ledger-more-matches={props.partial ? '' : undefined}
        >
          {`${String(props.passed)} of ${String(props.inView)} entries`}
          {props.partial ? '; more match than the search reads (500+)' : null}
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
  const continued = continues(pages.more.from, first) ? pages.more : NONE;
  const days = [...first.ledger.days, ...continued.days];
  const earlier = continued.days.length === 0 ? first.ledger.earlier : continued.earlier;
  const shown = passing(days, search);
  const passed = shown.reduce((sum, day) => sum + day.events.length, 0);
  const inView = days.reduce((sum, day) => sum + day.events.length, 0);
  const reading = readingLine(search, passed);
  const partial = first.query !== null && first.ledger.more === true;
  return (
    <>
      <SearchLines reading={reading} passed={passed} inView={inView} partial={partial} />
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
