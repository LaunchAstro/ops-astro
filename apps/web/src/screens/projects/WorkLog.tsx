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
// `Load earlier days` asks for the page before the last day drawn and adds it
// below. The earlier pages belong to the first page they continue: a reload or
// a new reader starts again from the newest days, and a page that arrives for
// a first page no longer drawn is dropped rather than drawn under it.

import { useRef, useState, type ReactElement } from 'react';
import { Button, Ledger, SearchBox } from '@launchastro/ui';
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
import { usePeopleSeen, useTyped } from './work-log-typed.ts';
import { NoMatch, SearchLines } from './work-log-lines.tsx';

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
  const { state, reload } = useRead<LedgerRead>({
    grantKey,
    run: () => readNewest(client, ownZone(), query),
    deps: [query],
  });
  const accepted = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  if (accepted !== null && accepted !== answer) setAnswer(accepted);
  const pages = useEarlierDays(client, answer);
  // Only this reader's: `accepted` is always the current grant's read.
  if (accepted !== null)
    people.see([...accepted.ledger.days, ...(pages.more.from === accepted ? pages.more.days : [])]);
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
function useEarlierDays(client: OperationsClient, answer: LedgerRead | null): EarlierDays {
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
        if (current.current !== from) return now;
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
  const partial = first.query !== null && first.ledger.more === true;
  const loading = pages.asking === first;
  const loadEarlier = (): void => pages.loadEarlier(first, days);
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
          today={todayIn(first.zone)}
          timeZone={first.zone}
          taskHref={(key) => pathTo('agency:task-detail', { key })}
          onOpenTask={(key) => {
            navigate(pathTo('agency:task-detail', { key }));
          }}
          onLoadEarlier={loadEarlier}
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
