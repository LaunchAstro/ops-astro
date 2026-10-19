// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal as a card in the chat (designs/chat-path-slice.md,
// piece 2), in the plan card's look. It shows exactly what the click sends:
// the title, the description, the due day and the estimate for a new task,
// which goes to whoever clicks, or
// the changes to the task the chat is open on, or, in a chat opened on no
// task, to the task the person picks among those it created
// (`proposal-pick.tsx`), the click disabled until then. The one click is "Create task" or "Apply to this task";
// after it the card links the task, or quotes the server's refusal and offers
// the click again; an edit whose task changed since says so and offers none.
// A site change (#1988) plays its plan back instead of the description: the
// site, the page, the text before and after, who it is for and the estimate;
// its one click is the same Create task.
// Nothing is written by the card being drawn, and every word on it is text:
// nothing a model wrote is markup.

import type { ReactElement } from 'react';
import { dayWords, timeWords } from '../../board/project-words.ts';
import { picked, ProposalPick } from './proposal-pick.tsx';
import type { AssistantPickMove, AssistantProposal, AssistantSitePlan } from './types.ts';

const SEND = { create: 'Create task', edit: 'Apply to this task' } as const;
const KEPT = { create: 'Task created', edit: 'Task updated' } as const;
const HEAD = { create: 'Proposed task', edit: 'Proposed change to this task' } as const;
const PICK_HEAD = 'Proposed change to a task this chat created';
const SITE_HEAD = 'Proposed site change';
/** Said until the click lands: a reply's words saying it was done never made it so. */
const PENDING = {
  create: 'Only proposed: no task exists until you click Create task.',
  edit: 'Only proposed: nothing on the task changes until you click Apply to this task.',
} as const;

function Done(props: { readonly proposal: AssistantProposal }): ReactElement | null {
  const { proposal } = props;
  if (proposal.task === null) return null;
  return (
    <div className="aip__plan-done" data-proposal="done">
      <span>{KEPT[proposal.action]}</span>
      <a href={proposal.task.href} data-proposal="task">
        {proposal.task.label}
      </a>
    </div>
  );
}

/** The plan played back, each line as text. */
function SitePlayback(props: { readonly site: AssistantSitePlan }): ReactElement {
  const { site } = props;
  const lines = [
    ['site', 'Site', site.repository],
    ['page', 'Page', site.page],
    ['before', 'Before', site.before],
    ['after', 'After', site.after],
    ['client', 'For', site.client === 'internal' ? 'Internal' : site.client],
  ] as const;
  return (
    <>
      {lines.map(([key, label, value]) => (
        <p className="aip__plan-words" key={key}>
          <span className="aip__plan-meta">{`${label}: `}</span>
          <span data-proposal-site={key}>{value}</span>
        </p>
      ))}
    </>
  );
}

/** What the click sends, each as text: the words, the due day and the estimate. */
function Proposed(props: { readonly proposal: AssistantProposal }): ReactElement {
  const { proposal } = props;
  const edit = proposal.action === 'edit';
  return (
    <>
      {proposal.title === null ? null : (
        <p className="aip__plan-words">
          {edit ? <span className="aip__plan-meta">Title: </span> : null}
          <strong data-proposal="title">{proposal.title}</strong>
        </p>
      )}
      {proposal.site === undefined ? null : <SitePlayback site={proposal.site} />}
      {proposal.description === null || proposal.site !== undefined ? null : (
        <p className="aip__plan-words">
          {edit ? <span className="aip__plan-meta">Description: </span> : null}
          <span data-proposal="description">{proposal.description}</span>
        </p>
      )}
      {proposal.due === undefined ? null : (
        <p className="aip__plan-meta" data-proposal="due">
          Due {dayWords(proposal.due)}
        </p>
      )}
      {proposal.estimate === undefined ? null : (
        <p className="aip__plan-meta" data-proposal="estimate">
          Estimate {timeWords(proposal.estimate)}
        </p>
      )}
      {edit ? null : (
        <p className="aip__plan-meta" data-proposal="assignee">
          Assigned to you
        </p>
      )}
    </>
  );
}

export function ProposalCard(props: {
  readonly proposal: AssistantProposal;
  readonly onSend: (() => void) | undefined;
  readonly onPick?: ((move: AssistantPickMove) => void) | undefined;
}): ReactElement {
  const { proposal, onSend } = props;
  const { pick } = proposal;
  return (
    <div className="aip__plan" data-proposal="card" data-action={proposal.action}>
      <span className="aip__plan-k">
        {pick === undefined
          ? proposal.site === undefined
            ? HEAD[proposal.action]
            : SITE_HEAD
          : PICK_HEAD}
      </span>
      {pick === undefined ? null : <ProposalPick pick={pick} onPick={props.onPick} />}
      <Proposed proposal={proposal} />
      {proposal.state === 'made' ? null : (
        <p className="aip__plan-meta" data-proposal="pending">
          {PENDING[proposal.action]}
        </p>
      )}
      {proposal.refusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert" data-proposal="refusal">
          {proposal.refusal}
        </p>
      )}
      {proposal.state === 'made' ? (
        <Done proposal={proposal} />
      ) : onSend === undefined || proposal.state === 'stale' ? null : (
        <div className="aip__plan-act">
          <button
            className="btn btn--primary btn--sm"
            type="button"
            data-proposal="send"
            disabled={proposal.state === 'sending' || !picked(pick)}
            onClick={onSend}
          >
            {proposal.state === 'unknown' ? 'Send again' : SEND[proposal.action]}
          </button>
        </div>
      )}
    </div>
  );
}
