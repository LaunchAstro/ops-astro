// SPDX-License-Identifier: AGPL-3.0-only
//
// Executive section 005, what our agents cost us (MP-14-6, CS-14.10; mockup
// `/agency/executive/` #agentcost). One read, `finance.agent_costs`, for the
// last thirty days: the tiles, the cost log and the two roll-ups beside it are
// all drawn from its answer, so they cannot disagree.
//
// Internal only: it is cost to us, never an amount a client is billed, and the
// section says so in its own markup (`data-view="agency"`). A run with no
// known cost says so and is never a zero; a run that belongs to no client is
// the agency's. The log folds at 8 rows, as the book does.

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Card, Empty, Kpi, Meter, Table, Term } from '@launchastro/ui';
import type {
  AgentCostRowView,
  AgentCostsResult,
  CostAttachment,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { money } from '../../views/proposal-record.tsx';

const DAY = 86_400_000;
const FOLD = 8;
const TIP =
  'What our own agent runs cost, priced at list API rates. Internal only: this is cost to us, not anything a client is charged.';

type Costs =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly costs: AgentCostsResult }
  | { readonly state: 'refused' }
  | { readonly state: 'unavailable'; readonly because: string };

const cost = (minor: string, currency: string): string => money(Number(minor), currency);
const day = (at: string): string =>
  new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const agentName = (id: string | null): string =>
  id === null ? 'An unnamed agent' : `Agent ${id.slice(0, 8)}`;
const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

function Who(props: { readonly attachment: CostAttachment }): ReactElement {
  const { attachment } = props;
  return attachment.kind === 'agency' ? (
    <span className="marker" data-cost-who>
      the agency
    </span>
  ) : (
    <span data-cost-who>{attachment.name ?? 'A client'}</span>
  );
}

function Spend(props: { readonly row: AgentCostRowView }): ReactElement {
  const { row } = props;
  return row.cost === null ? (
    <span className="t-2" data-cost-unpriced title={row.unpriced ?? undefined}>
      no price yet
    </span>
  ) : (
    <span className="num">{cost(row.cost, row.currency)}</span>
  );
}

function Models(props: { readonly row: AgentCostRowView }): ReactElement {
  const { ids, unnamedCalls } = props.row.models;
  return (
    <>
      {ids.map((id) => (
        <span key={id} className="skc__model">
          {id}
        </span>
      ))}
      {unnamedCalls === 0 ? null : (
        <span className="t-2"> {plural(unnamedCalls, 'call')} named no model</span>
      )}
    </>
  );
}

const COLUMNS = [
  { key: 'when', label: 'Started' },
  { key: 'model', label: 'Model' },
  { key: 'cost', label: 'Cost to us', align: 'end' },
  { key: 'who', label: 'Attached to' },
  { key: 'agent', label: 'Agent' },
] as const;

function logRow(row: AgentCostRowView): Readonly<Record<string, ReactNode>> {
  return {
    when: (
      <span className="t-2" data-cost-run={row.runId}>
        {day(row.startedAt)}
      </span>
    ),
    model: <Models row={row} />,
    cost: <Spend row={row} />,
    who: <Who attachment={row.attachment} />,
    agent: agentName(row.agentActorId),
  };
}

/** One roll-up line: its label, its spend against the currency's whole, and its runs. */
function Bar(props: {
  readonly label: ReactNode;
  readonly total: string;
  readonly of: number;
  readonly currency: string;
  readonly runs: number;
  readonly unpriced: number;
  readonly mark: Readonly<Record<string, string>>;
}): ReactElement {
  return (
    <div {...props.mark}>
      <div className="spread">
        <span className="t-sm">{props.label}</span>
        <span className="num">{cost(props.total, props.currency)}</span>
      </div>
      <Meter label={`${props.currency} share`} value={Number(props.total)} max={props.of} />
      <p className="t-2">
        {plural(props.runs, 'run')}
        {props.unpriced === 0 ? '' : ` · ${String(props.unpriced)} with no price yet`}
      </p>
    </div>
  );
}

/** Spend per currency, summed from the attachment roll-up (every run is in one bucket). */
function wholesOf(costs: AgentCostsResult): ReadonlyMap<string, number> {
  const wholes = new Map<string, number>();
  for (const line of costs.byAttachment) {
    wholes.set(line.currency, (wholes.get(line.currency) ?? 0) + Number(line.total));
  }
  return wholes;
}

function Tiles(props: {
  readonly costs: AgentCostsResult;
  readonly wholes: ReadonlyMap<string, number>;
}): ReactElement {
  const { costs, wholes } = props;
  const unpriced = costs.runs.filter((row) => row.cost === null).length;
  return (
    <div className="statrow g4">
      <div data-cost-kpi="runs">
        <Kpi label="Runs" value={String(costs.runs.length)} />
      </div>
      <div data-cost-kpi="unpriced">
        <Kpi label="With no price yet" value={String(unpriced)} />
      </div>
      {[...wholes].map(([currency, whole]) => (
        <div key={currency} data-cost-kpi={`total-${currency}`}>
          <Kpi label="API-equivalent cost" explain={TIP} value={money(whole, currency)} />
        </div>
      ))}
    </div>
  );
}

function Log(props: { readonly runs: readonly AgentCostRowView[] }): ReactElement {
  const { runs } = props;
  const [open, setOpen] = useState(false);
  const rows = open ? runs : runs.slice(0, FOLD);
  return (
    <Card flush>
      <Table caption="The cost log" columns={COLUMNS} rows={rows.map((row) => logRow(row))} dense />
      {open || runs.length <= FOLD ? null : (
        <button
          type="button"
          className="btn btn--ghost"
          data-cost-more
          onClick={() => setOpen(true)}
        >
          Show {String(runs.length - FOLD)} more
        </button>
      )}
    </Card>
  );
}

const attachedKey = (attachment: CostAttachment): string =>
  attachment.kind === 'client' ? attachment.id : 'agency';

function RollUps(props: {
  readonly costs: AgentCostsResult;
  readonly wholes: ReadonlyMap<string, number>;
}): ReactElement {
  const { costs, wholes } = props;
  return (
    <div className="stack">
      <Card title="By agent" sub="Each agent's runs in the period">
        {costs.byAgent.map((line) => (
          <Bar
            key={`${String(line.agentActorId)}:${line.currency}`}
            label={agentName(line.agentActorId)}
            total={line.total}
            of={wholes.get(line.currency) ?? 0}
            currency={line.currency}
            runs={line.runs}
            unpriced={line.unpricedRuns}
            mark={{ 'data-cost-agent': String(line.agentActorId) }}
          />
        ))}
      </Card>
      <Card
        title="By what it was attached to"
        sub="A task's client, or the agency when it has none"
      >
        {costs.byAttachment.map((line) => (
          <Bar
            key={`${attachedKey(line.attachment)}:${line.currency}`}
            label={<Who attachment={line.attachment} />}
            total={line.total}
            of={wholes.get(line.currency) ?? 0}
            currency={line.currency}
            runs={line.runs}
            unpriced={line.unpricedRuns}
            mark={{ 'data-cost-attached': attachedKey(line.attachment) }}
          />
        ))}
      </Card>
    </div>
  );
}

function Shown(props: { readonly costs: AgentCostsResult }): ReactElement {
  const wholes = wholesOf(props.costs);
  return (
    <>
      <Tiles costs={props.costs} wholes={wholes} />
      <div className="grid g-2fr1">
        <Log runs={props.costs.runs} />
        <RollUps costs={props.costs} wholes={wholes} />
      </div>
    </>
  );
}

export function AgentCostSection(props: {
  readonly client: OperationsClient;
  readonly now: () => number;
}): ReactElement | null {
  const { client, now } = props;
  const [costs, setCosts] = useState<Costs>({ state: 'loading' });
  useEffect(() => {
    const to = now();
    void (async () => {
      const answer = await client.read<AgentCostsResult>('finance.agent_costs', {
        from: new Date(to - 30 * DAY).toISOString(),
        to: new Date(to).toISOString(),
      });
      if (isUnavailable(answer)) setCosts({ state: 'unavailable', because: answer.because });
      else if (isRefusal(answer)) setCosts({ state: 'refused' });
      else setCosts({ state: 'shown', costs: answer.value });
    })();
  }, [client, now]);
  if (costs.state === 'refused' || costs.state === 'loading') return null;
  return (
    <section className="sec" id="agentcost" data-section="005" data-view="agency" data-agent-costs>
      <h2>
        005 <Term tip={TIP}>What our agents cost us</Term>{' '}
        <span className="t-2">
          {costs.state === 'shown' ? plural(costs.costs.runs.length, 'run') : 'Runs'} ·
          API-equivalent
        </span>
      </h2>
      {costs.state === 'unavailable' ? (
        <p>What our agents cost could not be read: {costs.because}</p>
      ) : (
        <>
          <p className="t-2" data-cost-period>
            {day(costs.costs.period.from)} to {day(costs.costs.period.to)}
          </p>
          {costs.costs.runs.length === 0 ? (
            <Empty look="inline" title="No agent ran in this period." />
          ) : (
            <Shown costs={costs.costs} />
          )}
        </>
      )}
    </section>
  );
}
