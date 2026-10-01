// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up agent reads for the width-and-theme harness (UI-POLISH, SL12): the
// run on the made-up T-1 and a conversation at its own address. Typed against
// the wire contract's read shapes, like made-up-api.ts, and test side only.
//
// T-1's run follows the mockup's rich agent task: its newest version waits at
// an armed gate, the version before it is superseded, it staged a diff, ran
// three checks, revised its knowledge twice, and spent past its allowance
// into a waiting stop. Every name, address and figure is made up.

import type {
  AwaitingReviewResult,
  ConversationListResult,
  ConversationReadResult,
  ProposalVersionView,
  ProposalView,
  TaskLedgerView,
} from '../../packages/core-wire/src/index.ts';

const DIGEST = 'sha256:7c41e8f9a2d6b3915e0c47a8fd23b6c1e94a7f80d5b2c6e31a94f7d2b8c05e4a2';
const EARLIER = 'sha256:2b90c4d1e7f3a85602c9d4e1b7a3f0582c6e9d1f4b7a2c05e8d3f6a91b4c7e2d0';
const AGENT_ACTOR = 'a-agent';

const check = (n: number, name: string): ProposalVersionView['checks'][number] => ({
  id: `chk-${String(n)}`,
  name,
  outcome: 'passed',
  note: null,
  performedByActorId: AGENT_ACTOR,
  recordedAt: `2026-09-25T0${String(n)}:20:00.000Z`,
});

/** What each run was given and read: one pinned instruction file. */
const GIVEN: Pick<ProposalVersionView, 'pins' | 'reads'> = {
  pins: [
    {
      kind: 'bootstrap',
      path: 'AGENTS.md',
      digest: 'sha256:9f2c1a7e',
      size: 2_048,
      readAt: '2026-09-25T02:15:00.000Z',
      definitionVersionId: null,
      pinnedAt: '2026-09-25T02:15:00.000Z',
    },
  ],
  reads: [
    {
      sequence: 1,
      path: 'AGENTS.md',
      digest: 'sha256:9f2c1a7e',
      size: 2_048,
      readAt: '2026-09-25T02:15:00.000Z',
      isEntry: true,
    },
  ],
};

/** The diff each version staged (DA-05's first kind). */
const evidenceOf = (n: 1 | 2): ProposalVersionView['evidence'] => ({
  id: `ev-${String(n)}`,
  renderer: 'staged',
  digest: n === 2 ? DIGEST : EARLIER,
  body: {
    staged: {
      kind: 'diff',
      where: 'Contract review pack, cover note',
      was: 'Scope and one variation.',
      will: 'Signed scope, both variations and the renewal terms.',
    },
  },
});

const version = (n: 1 | 2): ProposalVersionView => ({
  versionId: `v-${String(n)}`,
  version: n,
  purpose: 'contract_review_pack',
  maximumMinor: 12_000,
  currency: 'AUD',
  payloadDigest: n === 2 ? DIGEST : EARLIER,
  payload: { pack: 'Signed scope, two variations and the renewal terms, in one PDF.' },
  supersededAt: n === 2 ? null : '2026-09-25T02:10:00.000Z',
  runId: `run-${String(n)}`,
  startedAt: n === 2 ? '2026-09-25T02:15:00.000Z' : '2026-09-24T23:40:00.000Z',
  endedAt: n === 2 ? '2026-09-25T03:05:00.000Z' : '2026-09-25T00:30:00.000Z',
  tokenUnits: n === 2 ? 48_200 : 21_600,
  ...GIVEN,
  evidence: evidenceOf(n),
  gate:
    n === 2
      ? {
          id: 'g-2',
          state: 'pending',
          round: 1,
          expiresAt: '2026-10-03T00:00:00.000Z',
          expired: false,
          payloadDigest: DIGEST,
        }
      : null,
  checks: n === 2 ? [check(1, 'variations present'), check(2, 'terms dated')] : [],
});

/** The first attempt, finished before this one: its approval's reservation settled. */
const EARLIER_ATTEMPT: ProposalView = {
  lineageId: 'l-1',
  state: 'completed',
  versions: [
    {
      ...version(1),
      versionId: 'v-0',
      runId: 'run-0',
      supersededAt: null,
      gate: {
        id: 'g-0',
        state: 'approved',
        round: 1,
        expiresAt: '2026-09-27T00:00:00.000Z',
        expired: false,
        payloadDigest: EARLIER,
      },
    },
  ],
  decisions: [],
  reservations: [
    {
      id: 'r-1',
      envelopeId: 'env-1',
      runId: 'run-0',
      state: 'actual',
      heldMinor: 6_000,
      actualMinor: 5_400,
      releasedMinor: 600,
      classifiedCause: null,
      leaseId: 'lease-1',
      lease: null,
      attempt: null,
    },
  ],
  scopes: [],
};

/**
 * T-1's attempts, newest first as `task.read` sends them: the current one at
 * its armed gate, with the version it superseded, then the finished first one.
 */
export const AGENT_PROPOSALS: readonly ProposalView[] = [
  {
    lineageId: 'l-2',
    state: 'live',
    versions: [version(2), version(1)],
    decisions: [],
    reservations: [],
    scopes: [],
  },
  EARLIER_ATTEMPT,
];

/** T-1's token ledger: past its allowance, a stop waiting, two knowledge revisions. */
export const AGENT_LEDGER: TaskLedgerView = {
  envelopes: [
    {
      id: 'env-1',
      state: 'open',
      maximumMinor: 12_000,
      heldMinor: 0,
      actualMinor: 12_900,
      currency: 'AUD',
      openedAt: '2026-09-24T23:30:00.000Z',
      closedAt: null,
      openedBy: { versionId: 'v-1' },
      cap: { key: 'agency-monthly', limitMinor: 500_000, currency: 'AUD' },
    },
  ],
  stops: [
    {
      askId: 'ask-1',
      runId: 'run-2',
      number: 1,
      kind: 'stop',
      ceilingMinor: 12_000,
      spentMinor: 12_900,
      currency: 'AUD',
      raisedAt: '2026-09-25T03:05:00.000Z',
      answer: null,
      awaitingSecond: null,
    },
  ],
  states: [
    {
      runId: 'run-2',
      version: 2,
      knowledge: ['Variation two is signed.', 'Renewal terms run to June 2027.'],
      unknowns: ['Whether the client wants the old scope kept in the pack.'],
      revisedBy: { actorId: AGENT_ACTOR },
      revisedAt: '2026-09-25T02:50:00.000Z',
    },
    {
      runId: 'run-2',
      version: 1,
      knowledge: ['Variation two is signed.'],
      unknowns: ['Which renewal terms apply.'],
      revisedBy: { actorId: AGENT_ACTOR },
      revisedAt: '2026-09-25T02:20:00.000Z',
    },
  ],
};

/** The conversation id the harness opens at `/agent/:conversation`. */
export const CONVERSATION_ID = 'c-0001';
const ADDRESS = `/agent/${CONVERSATION_ID}`;

/** The agent reads' made-up answers, by read name. */
export const AGENT_READS: {
  readonly 'gate.pending': AwaitingReviewResult;
  readonly 'conversation.list': ConversationListResult;
  readonly 'conversation.read': ConversationReadResult;
} = {
  'gate.pending': {
    ok: true,
    awaiting: [
      {
        gateId: 'g-2',
        versionId: 'v-2',
        version: 2,
        lineageId: 'l-2',
        taskId: '00000000-0000-4000-8000-000000000001',
        taskTitle: 'Contract review pack, 31 July',
        purpose: 'contract_review_pack',
        maximumMinor: 12_000,
        currency: 'AUD',
        round: 1,
        expiresAt: '2026-10-03T00:00:00.000Z',
      },
    ],
  },
  'conversation.list': {
    ok: true,
    conversations: [
      {
        id: CONVERSATION_ID,
        address: ADDRESS,
        title: 'Renewal pack questions',
        lastActivityAt: '2026-09-25T04:10:00.000Z',
        bodyPurged: false,
      },
    ],
  },
  'conversation.read': {
    ok: true,
    conversation: {
      id: CONVERSATION_ID,
      address: ADDRESS,
      title: 'Renewal pack questions',
      subject: 'Contract review pack, 31 July',
      scope: { kind: 'task', id: '00000000-0000-4000-8000-000000000001' },
      page: null,
      createdAt: '2026-09-25T04:00:00.000Z',
      lastActivityAt: '2026-09-25T04:10:00.000Z',
      bodyPurgedAt: null,
    },
    messages: [
      {
        id: 'm-1',
        role: 'person',
        body: 'Which variations are still unsigned?',
        createdAt: '2026-09-25T04:00:00.000Z',
      },
      {
        id: 'm-2',
        role: 'agent',
        body: 'Variation two was signed on 24 September. None is unsigned now.',
        createdAt: '2026-09-25T04:01:00.000Z',
      },
    ],
    wrapUp: null,
    wrapUpHistory: [],
  },
};
