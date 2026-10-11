// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings General ▸ Your AI agents (Assign to AI): the signed-in person's own
// agents, read with `agent.mine`, each renamed with `agent.rename`, and a new
// one made with `agent.create`. An agent made here can be handed a task from
// the task page or the board, and keeps it until a person changes it; making
// or naming one starts no work. After each write the list is read again, and a
// refusal is shown in the server's words. Make my agent holds one operation id
// for the name typed until an answer arrives, so a retry after a lost answer
// replays the first create instead of making a second agent.

import { useRef, useState, type ReactElement } from 'react';
import type { AgentMineResult } from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { describeFailure, type SubmitResult } from '../../records/submit.ts';
import { RecordState } from '../../views/record-state.tsx';

type Send = (send: () => Promise<SubmitResult>, done: string) => void;

/** The read's agents; a server that predates `agent.mine` sends none. */
const agentsOf = (result: Partial<AgentMineResult>): AgentMineResult['agents'] =>
  result.agents ?? [];

function NameForm(props: {
  readonly id: string;
  readonly label: string;
  readonly button: string;
  readonly initial: string;
  readonly busy: boolean;
  readonly onSave: (name: string) => void;
}): ReactElement {
  const [name, setName] = useState(props.initial);
  const unchanged = name.trim() === '' || name.trim() === props.initial;
  return (
    <form
      className="setrow__ctl"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged) props.onSave(name.trim());
      }}
    >
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="input"
        maxLength={60}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        className="btn btn--sm btn--secondary"
        type="submit"
        disabled={props.busy || unchanged}
      >
        {props.button}
      </button>
    </form>
  );
}

/** A write's outcome: the server's words for a refusal, a quiet line for a success. */
function Outcome(props: { readonly text: string; readonly refused: boolean }): ReactElement {
  return (
    <p
      className={props.refused ? 'field__error' : 'card__sub'}
      role={props.refused ? 'alert' : 'status'}
      data-agents-outcome={props.refused ? 'refused' : 'done'}
    >
      {props.text}
    </p>
  );
}

/** Make my agent: one operation id per name typed, held until an answer arrives. */
function useMake(client: OperationsClient, send: Send): (name: string) => void {
  const making = useRef<{ readonly name: string; readonly id: string } | null>(null);
  return (name) => {
    if (making.current?.name !== name) making.current = { name, id: client.newOperationId() };
    const operationId = making.current.id;
    send(async () => {
      const answer = await client.mutate('agent.create', { name }, { operationId });
      if (!isUnavailable(answer)) making.current = null;
      return answer;
    }, `Made your agent ${name}.`);
  };
}

/** Each agent with its rename, then the form that makes a new one. */
function AgentRows(props: {
  readonly client: OperationsClient;
  readonly agents: AgentMineResult['agents'];
  readonly busy: boolean;
  readonly send: Send;
  readonly make: (name: string) => void;
}): ReactElement {
  const { client, send } = props;
  return (
    <div className="set" data-agents-list>
      {props.agents.map((agent) => (
        <div className="setrow" key={agent.agentId} data-agent={agent.agentId}>
          <NameForm
            id={`agent-name-${agent.agentId}`}
            label="Name"
            button="Rename"
            initial={agent.name}
            busy={props.busy}
            onSave={(name) =>
              send(
                () => client.mutate('agent.rename', { agentId: agent.agentId, name }),
                `Renamed ${agent.name} to ${name}.`,
              )
            }
          />
        </div>
      ))}
      <div className="setrow" data-agent-new>
        <NameForm
          key={props.agents.length}
          id="agent-new-name"
          label="New agent"
          button="Make my agent"
          initial=""
          busy={props.busy}
          onSave={props.make}
        />
      </div>
    </div>
  );
}

export function AgentsGroup(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<AgentMineResult>({
    grantKey: props.grantKey,
    run: () => client.read<AgentMineResult>('agent.mine', {}),
    deps: [client],
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; refused: boolean } | null>(null);
  const send: Send = (write, done) => {
    setBusy(true);
    void (async () => {
      const failure = describeFailure(await write());
      setBusy(false);
      setOutcome({ text: failure ?? done, refused: failure !== null });
      if (failure === null) reload();
    })();
  };
  const make = useMake(client, send);
  return (
    <section data-pref="agents" aria-label="Your AI agents">
      <div className="card set__card">
        <h2 className="card__title">Your AI agents</h2>
        <p className="card__sub">
          Agents you own. Hand one a task from the task page or the board: it keeps the task until
          someone changes it. Making or naming an agent starts no work.
        </p>
        {outcome === null ? null : <Outcome {...outcome} />}
        <RecordState state={state} subject="list of your agents" onRetry={reload}>
          {(result) => (
            <AgentRows
              client={client}
              agents={agentsOf(result)}
              busy={busy}
              send={send}
              make={make}
            />
          )}
        </RecordState>
      </div>
    </section>
  );
}
