// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2142): the Review workspace shows each revision's decision from `review.read`, and
// a person holding gate:decide approves the revision under review through `review.decide`
// with the digest the screen shows. A refusal shows its fix and changes nothing; one attempt
// id per approval, kept for a retry; an answer for a revision the screen has moved past, or
// for a business it has left, is dropped. No approve control for an agent or a person
// without gate:decide, and a client's refused read draws no decision.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { MIA, NATHAN } from '../visual/made-up-access.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

type Review = typeof REVIEW;
type Revision = NonNullable<Review['review']['after']>;

const [first, second] = REVIEW.review.revisions as [Revision, Revision];

const approvedBy = (revision: Revision, personId: string, self: boolean): Revision => ({
  ...revision,
  decision: {
    response: 'approve',
    digest: revision.digest,
    decidedByPersonId: personId,
    singleOperatorSelfApproval: self,
    decidedAt: '2026-10-19T03:00:00.000Z',
  },
});

/** Revision 1 approved by Mia, a second person; revision 2, new, undecided. */
const DECIDED: Review = {
  ok: true,
  review: {
    ...REVIEW.review,
    revisions: [approvedBy(first, 'p-mia', false), second],
    before: approvedBy(first, 'p-mia', false),
    after: second,
  },
};

/** The same review once revision 2 is approved by Nathan in single-operator mode. */
const APPROVED: Review = {
  ok: true,
  review: {
    ...DECIDED.review,
    revisions: [approvedBy(first, 'p-mia', false), approvedBy(second, 'p-nathan', true)],
    after: approvedBy(second, 'p-nathan', true),
  },
};

const third: Revision = {
  ...second,
  revisionId: '55555555-5555-4555-8555-000000000003',
  number: 3,
  digest: `sha256:${'7'.repeat(64)}`,
};

/** A third revision has landed since: it is under review, undecided. */
const MOVED_ON: Review = {
  ok: true,
  review: { ...DECIDED.review, revisions: [...DECIDED.review.revisions, third], after: third },
};

const DECIDE = { collection: 'gate', action: 'decide' } as const;
const READ = { collection: 'review', action: 'read' } as const;

interface World {
  read: unknown;
  grants: readonly { readonly collection: string; readonly action: string }[];
  agent?: string;
  /** The answer to the nth `review.decide`, counted from 1. */
  decide: (count: number) => Promise<Response>;
}

interface Sent {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function clientFor(world: World, businessKey = 'alpha') {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Readonly<
      Record<string, unknown>
    >;
    sent.push({ path, body });
    if (path.endsWith('/review/read')) return Promise.resolve(json(world.read));
    if (path.endsWith('/review/picture')) {
      return Promise.resolve(json(pictureOf(body['pictureId'])));
    }
    if (path.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({
          ok: true,
          personId: 'p-nathan',
          businessKey,
          grants: world.grants,
          ...(world.agent === undefined ? {} : { agentActorId: world.agent }),
        }),
      );
    }
    if (path.endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: [NATHAN, MIA] }));
    }
    if (path.endsWith('/review/decide')) {
      return world.decide(sent.filter((each) => each.path === path).length);
    }
    throw new Error(`unrouted ${path}`);
  }) as unknown as typeof globalThis.fetch;
  return { client: new OperationsClient({ origin: '', businessKey, signedIn: true, fetch }), sent };
}

const refusal = (code: string, fixes: readonly string[], status = 409) =>
  json(
    { refused: true, code, names: code === 'SCOPE_NOT_GRANTED' ? [] : ['digest'], fixes },
    status,
  );

const nothing = (): void => {};

const settled = async () => {
  await tick();
  await tick();
  await tick();
  await tick();
};

async function drawn(world: World) {
  const { client, sent } = clientFor(world);
  let refresh: () => void = nothing;
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      rollup={{
        follow: (run) => {
          refresh = run;
          return () => {};
        },
      }}
    />,
  );
  await settled();
  const decides = () => sent.filter((each) => each.path.endsWith('/review/decide'));
  const reads = () => sent.filter((each) => each.path.endsWith('/review/read')).length;
  return { view, sent, decides, reads, refresh: () => act(() => Promise.resolve(refresh())) };
}

const person = (decide: World['decide'], read: unknown = DECIDED): World => ({
  read,
  grants: [DECIDE, READ],
  decide,
});

const never = (): Promise<Response> => new Promise(() => {});

it("shows each revision's decision, and a new revision as undecided", async () => {
  const { view } = await drawn(person(never));
  const one = view.find('[data-decision="1"]')?.textContent ?? '';
  expect(one).toContain('Approved');
  expect(one).toContain('by Mia');
  expect(one).toContain(first.digest.slice(7, 19));
  expect(one).toContain('a second person');
  expect(view.find('[data-decision="2"]')?.textContent).toContain('Undecided');
});

it('shows a self-approval in single-operator mode as one', async () => {
  const { view } = await drawn(person(never, APPROVED));
  const two = view.find('[data-decision="2"]')?.textContent ?? '';
  expect(two).toContain('by Nathan');
  expect(two).toContain('self-approved in single-operator mode');
  expect(view.find('[data-approve]')).toBeNull();
});

it('approves the revision under review with the digest shown, once, the retry under one id', async () => {
  const world = person((count) =>
    Promise.resolve(
      count === 1
        ? json({}, 503)
        : json({ recordId: REVIEW_ID, revision: null, decisionId: 'd1', digest: second.digest }),
    ),
  );
  const { view, decides, reads } = await drawn(world);
  await view.click('[data-approve] button');
  await settled();
  world.read = APPROVED;
  await view.click('[data-approve] button');
  await settled();
  expect(decides()).toHaveLength(2);
  expect(decides()[0]?.body).toMatchObject({
    reviewId: REVIEW_ID,
    digest: second.digest,
    response: 'approve',
  });
  expect(decides()[1]?.body['operationId']).toBe(decides()[0]?.body['operationId']);
  expect(reads()).toBe(2);
  expect(view.find('[data-decision="2"]')?.textContent).toContain('by Nathan');
  expect(view.find('[data-approve]')).toBeNull();
});

it.each([
  ['VERSION_STALE', 'Read the review again and name the digest of the revision it shows.'],
  ['SELF_APPROVAL_REFUSED', 'A second person approves the revision; ask another holder.'],
  ['ASTRA_REVIEW_MISSING', "Record Astra's approving review of this revision first."],
  ['SCOPE_NOT_GRANTED', 'Only a person decides a review, signed in as themselves.'],
])('a %s refusal shows its fix and changes nothing on screen', async (code, fix) => {
  const { view, reads } = await drawn(
    person(() => Promise.resolve(refusal(code, [fix], code === 'SCOPE_NOT_GRANTED' ? 403 : 409))),
  );
  const before = view.find('[data-revision-bar]')?.textContent;
  await view.click('[data-approve] button');
  await settled();
  const shown = view.find('[data-approve-refusal]')?.textContent ?? '';
  expect(shown).toContain(code);
  expect(shown).toContain(fix);
  expect(view.find('[data-revision-bar]')?.textContent).toBe(before);
  expect(view.find('[data-decision="2"]')?.textContent).toContain('Undecided');
  expect(reads()).toBe(1);
});

it('drops an answer for a revision the screen has moved past', async () => {
  let answer: (response: Response) => void = nothing;
  const world = person(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const { view, decides, reads, refresh } = await drawn(world);
  await view.click('[data-approve] button');
  world.read = MOVED_ON;
  await refresh();
  await settled();
  expect(view.find('[data-decision="3"]')?.textContent).toContain('Undecided');
  answer(refusal('VERSION_STALE', ['Read the review again.']));
  await settled();
  expect(decides()[0]?.body['digest']).toBe(second.digest);
  expect(view.find('[data-approve-refusal]')).toBeNull();
  expect(reads()).toBe(2);
  // The next approval is a new intent, for the digest now shown.
  world.decide = never;
  await view.click('[data-approve] button');
  expect(decides()[1]?.body['digest']).toBe(third.digest);
  expect(decides()[1]?.body['operationId']).not.toBe(decides()[0]?.body['operationId']);
});

it('drops an answer for a business the screen has left', async () => {
  let answer: (response: Response) => void = nothing;
  const world = person(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const { view, reads } = await drawn(world);
  await view.click('[data-approve] button');
  const bravo = clientFor({ ...world, read: DECIDED, decide: never }, 'bravo');
  await view.render(
    <ReviewWorkspaceScreen client={bravo.client} grantKey="bravo:member" reviewId={REVIEW_ID} />,
  );
  await settled();
  answer(json({ recordId: REVIEW_ID, revision: null, decisionId: 'd1', digest: second.digest }));
  await settled();
  expect(view.find('[data-approve-refusal]')).toBeNull();
  // Alpha's answer starts no read: alpha's one, then bravo's.
  expect(reads()).toBe(1);
  expect(bravo.sent.filter((each) => each.path.endsWith('/review/read'))).toHaveLength(1);
});

it.each([
  ['an agent session', { grants: [DECIDE, READ], agent: 'a-agent' }],
  ['a person without gate:decide', { grants: [READ] }],
])('draws no approve control for %s', async (_, session) => {
  const { view, decides } = await drawn({ read: DECIDED, decide: never, ...session });
  expect(view.find('[data-decision="2"]')?.textContent).toContain('Undecided');
  expect(view.find('[data-approve]')).toBeNull();
  expect(decides()).toHaveLength(0);
});

it('draws no decision for a client, whose review read is refused', async () => {
  const { view } = await drawn(
    person(never, { refused: true, code: 'NOT_FOUND', names: [], fixes: [] }),
  );
  expect(view.find('[data-decision]')).toBeNull();
  expect(view.text()).not.toContain('Approved');
  expect(view.text()).not.toContain('Mia');
  expect(view.find('[data-approve]')).toBeNull();
});
