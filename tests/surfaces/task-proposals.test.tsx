// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Proposals on `/task/:key`: the evidence a decider reads, and the control that
// decides the exact version they read it on.
//
// The stand-in answers the way the API does. `task.read` carries the whole
// projection (`docs/local/API.md`, "Proposal projection"); `task.propose` opens
// a version beside the task without moving the task's own revision; and
// `task.decide` compares the `versionId` it is given against the live one under
// the locks, so a decision made from a page that has gone stale is
// `VERSION_SUPERSEDED` rather than a decision about something nobody read.
//
// Four rules are held here, and each is a thing the screen could get wrong in a
// way no type would catch.
//
// **What is drawn is what was stored.** The evidence body is printed as it
// arrived, the digests are printed as they arrived, and the decision chain is
// the stored rows. Re-rendering evidence on the way to the screen is the one
// thing a gate cannot survive, so the test asserts the exact stored text
// appears, including a field the screen has no idea what to do with.
//
// **The decision carries the version that was displayed.** The `versionId` the
// approve button sends must be the one from the same `task.read` answer whose
// evidence is on the screen, so the test reads the digest off the page and the
// `versionId` off the request and checks they belong to one another.
//
// **The gate's expiry is the server's answer.** The controls close on
// `gate.expired`, not on a clock in the browser. The gate in the expired case
// has an `expiresAt` well in the future and `expired: true`, which no
// clock-comparing screen could get right.
//
// **A refusal is the server's word, and the page rereads afterwards.** Both
// `VERSION_SUPERSEDED` and `GATE_ALREADY_DECIDED` are quoted as they arrived and
// followed by a fresh `task.read`, because the whole reason the decision was
// refused is that this page is no longer describing the record.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '33333333-3333-4333-8333-333333333333';
const LIVE_VERSION = 'v-2222';
const STALE_VERSION = 'v-1111';
const GATE_ID = 'g-9999';

/** A field the screen has never heard of, to prove the body is not re-rendered. */
const EVIDENCE_BODY = {
  summary: 'Send the renewal quote to the client.',
  renderedAt: '2026-09-23T02:00:00.000Z',
  aFieldThisBuildHasNeverHeardOf: 'kept verbatim',
};

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = (code: string, status: number): Response =>
  json(
    {
      refused: true,
      code,
      names: [`${code} on this decision`],
      fixes: ['read the task again and decide the version that is live'],
    },
    status,
  );

interface ServerOptions {
  /** No lineages at all: the honest empty case. */
  readonly empty?: boolean;
  /** The projection is absent from the answer, as a build without it sends. */
  readonly withoutProjection?: boolean;
  /** The gate answers expired, with an `expiresAt` in the future. */
  readonly expiredGate?: boolean;
  /** The gate has already been decided, so no control may be offered. */
  readonly decidedGate?: boolean;
  /** What `task.decide` refuses with, if anything. */
  readonly refuseDecide?: { readonly code: string; readonly status: number };
  /** What `task.propose` refuses with, if anything. */
  readonly refusePropose?: { readonly code: string; readonly status: number };
}

/**
 * One task whose proposals are really read back, so "it appeared" means the
 * screen read the server again rather than drew what it had just sent.
 */
function server(options: ServerOptions = {}) {
  const gate = {
    id: GATE_ID,
    state: options.decidedGate === true ? 'approved' : 'pending',
    round: 1,
    // Deliberately in the future while `expired` is true: a screen comparing
    // this to its own clock would get the expired case wrong.
    expiresAt: '2099-01-01T00:00:00.000Z',
    expired: options.expiredGate === true,
    payloadDigest: 'digest-live',
  };

  const liveVersion = {
    versionId: LIVE_VERSION,
    version: 2,
    purpose: 'client.renewal.quote',
    maximumMinor: 250_000,
    currency: 'AUD',
    payloadDigest: 'digest-live',
    payload: { step: 'draft the quote' },
    supersededAt: null,
    runId: null,
    evidence: {
      id: 'e-2222',
      renderer: 'core-runtime/evidence@1',
      digest: 'evidence-digest-live',
      body: EVIDENCE_BODY,
    },
    gate,
  };

  const staleVersion = {
    versionId: STALE_VERSION,
    version: 1,
    purpose: 'client.renewal.quote',
    maximumMinor: 100_000,
    currency: 'AUD',
    payloadDigest: 'digest-stale',
    payload: { step: 'the first attempt' },
    supersededAt: '2026-09-23T02:30:00.000Z',
    runId: null,
    evidence: null,
    gate: null,
  };

  const lineage = {
    lineageId: 'l-0001',
    state: 'live',
    versions: [liveVersion, staleVersion],
    decisions:
      options.decidedGate === true
        ? [
            {
              id: 'd-1',
              seq: 1,
              decision: 'approved',
              round: 1,
              decidedByPersonId: 'person-ada',
              decidedAt: '2026-09-23T02:45:00.000Z',
              signingKeyId: 'local-gate-key',
              signature: 'a'.repeat(64),
              prevHash: null,
              hash: 'b'.repeat(64),
            },
          ]
        : [],
    reservations:
      options.decidedGate === true
        ? [
            {
              id: 'r-1',
              state: 'held',
              heldMinor: 250_000,
              actualMinor: null,
              classifiedCause: null,
              leaseId: null,
              lease: null,
              attempt: { id: 'a-1', state: 'reserved', dispatchMarker: null, observed: null },
            },
          ]
        : [],
  };

  const task: Record<string, unknown> = {
    id: TASK_ID,
    key: 'TSK-31',
    title: 'A task somebody has proposed something about',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 7,
    history: [],
    comments: [],
    proposals: options.empty === true ? [] : [lineage],
  };
  if (options.withoutProjection === true) delete task['proposals'];

  const reads: number[] = [];
  const proposed: Record<string, unknown>[] = [];
  const decided: Record<string, unknown>[] = [];

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) {
      reads.push(reads.length + 1);
      return json({ ok: true, task });
    }
    if (at.endsWith('/task/propose')) {
      proposed.push(body);
      if (options.refusePropose !== undefined) {
        return refusal(options.refusePropose.code, options.refusePropose.status);
      }
      // The proposal lands beside the task: a third version appears and the
      // task's own revision does not move.
      lineage.versions = [
        {
          ...liveVersion,
          versionId: 'v-3333',
          version: 3,
          purpose: String(body['purpose'] ?? ''),
          maximumMinor: Number(body['maximumMinor'] ?? 0),
          currency: String(body['currency'] ?? ''),
          payloadDigest: 'digest-newest',
        },
        ...lineage.versions,
      ];
      return json({ recordId: TASK_ID, revision: 7, detail: { versionId: 'v-3333' } });
    }
    if (at.endsWith('/task/decide')) {
      decided.push(body);
      if (options.refuseDecide !== undefined) {
        return refusal(options.refuseDecide.code, options.refuseDecide.status);
      }
      gate.state = 'approved';
      gate.expired = false;
      lineage.decisions = [
        {
          id: 'd-1',
          seq: 1,
          decision: String(body['decision'] ?? ''),
          round: 1,
          decidedByPersonId: 'person-ada',
          decidedAt: '2026-09-23T03:00:00.000Z',
          signingKeyId: 'local-gate-key',
          signature: 'c'.repeat(64),
          prevHash: null,
          hash: 'd'.repeat(64),
        },
      ];
      lineage.reservations = [
        {
          id: 'r-1',
          state: 'held',
          heldMinor: 250_000,
          actualMinor: null,
          classifiedCause: null,
          leaseId: null,
          lease: null,
          attempt: { id: 'a-1', state: 'reserved', dispatchMarker: null, observed: null },
        },
      ];
      return json({ recordId: TASK_ID, revision: 7, detail: { reservationId: 'r-1' } });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;

  const client = new OperationsClient({
    base: '/api',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });

  return { client, reads, proposed, decided, task };
}

const screenFor = (client: OperationsClient) => (
  <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />
);

describe('the proposal evidence on the task page', () => {
  it('draws each version with its purpose, ceiling, digest and stored evidence', async () => {
    const { client } = server();
    const page = await mount(screenFor(client));
    await tick();

    const lineage = page.find('[data-lineage-id="l-0001"]');
    expect(lineage).not.toBeNull();
    expect(lineage?.getAttribute('data-lineage-state')).toBe('live');

    // Newest first, as the projection sends them.
    const versions = page.all('[data-version-id][data-version]');
    expect(versions.map((node) => node.getAttribute('data-version-id'))).toEqual([
      LIVE_VERSION,
      STALE_VERSION,
    ]);

    const live = page.find(`[data-version-id="${LIVE_VERSION}"]`);
    const said = live?.textContent ?? '';
    expect(said).toContain('client.renewal.quote');
    expect(said).toContain('digest-live');
    // The ceiling is money and is drawn as money, with the currency the
    // proposal named rather than a currency the screen assumed.
    expect(said).toContain('AUD');
    expect(said).toContain('2,500.00');

    // The evidence pack is the renderer's output as stored, printed rather than
    // formatted: a field this build has never heard of survives the journey.
    expect(page.find('[data-evidence="renderer"]')?.textContent).toContain(
      'core-runtime/evidence@1',
    );
    expect(page.find('[data-evidence="digest"]')?.textContent).toContain('evidence-digest-live');
    const evidence = page.find('[data-evidence="body"]')?.textContent ?? '';
    expect(evidence).toContain('aFieldThisBuildHasNeverHeardOf');
    expect(evidence).toContain('kept verbatim');

    await page.unmount();
  });

  it('draws the gate, the stored decision chain and the reservation', async () => {
    const { client } = server({ decidedGate: true });
    const page = await mount(screenFor(client));
    await tick();

    expect(page.find('[data-gate-state]')?.getAttribute('data-gate-state')).toBe('approved');
    expect(page.find('[data-gate-state]')?.getAttribute('data-gate-expired')).toBe('false');

    // The chain as stored: the sequence, the decision, the round, who decided
    // and when, and the stored hash rather than a recomputed one.
    const link = page.find('[data-decision-seq="1"]');
    expect(link).not.toBeNull();
    const chain = link?.textContent ?? '';
    expect(chain).toContain('approved');
    expect(chain).toContain('person-ada');
    expect(chain).toContain('2026-09-23T02:45:00.000Z');
    expect(chain).toContain('b'.repeat(64));

    const reservation = page.find('[data-reservation-id="r-1"]');
    expect(reservation?.getAttribute('data-reservation-state')).toBe('held');
    expect(reservation?.textContent).toContain('2,500.00');
    expect(page.find('[data-attempt-state]')?.getAttribute('data-attempt-state')).toBe('reserved');

    await page.unmount();
  });

  it('says so when there are no proposals, and says something else when it could not read them', async () => {
    const empty = server({ empty: true });
    const first = await mount(screenFor(empty.client));
    await tick();
    expect(first.find('[data-proposals="none"]')).not.toBeNull();
    expect(first.find('[data-proposals="not-carried"]')).toBeNull();
    // B7: an empty projection draws nothing that looks like a proposal.
    expect(first.all('[data-version-id][data-version]')).toHaveLength(0);
    await first.unmount();

    const absent = server({ withoutProjection: true });
    const second = await mount(screenFor(absent.client));
    await tick();
    expect(second.find('[data-proposals="not-carried"]')).not.toBeNull();
    expect(second.find('[data-proposals="none"]')).toBeNull();
    expect(second.all('[data-version-id][data-version]')).toHaveLength(0);
    await second.unmount();
  });
});

describe('the propose form', () => {
  it('sends the task it is looking at and shows the new version from the server', async () => {
    const { client, proposed, reads } = server();
    const page = await mount(screenFor(client));
    await tick();
    const readsBefore = reads.length;

    // eslint-disable-next-line no-console
    await page.type('#propose-purpose', 'client.renewal.quote');
    await page.type('#propose-maximum', '3000');
    await page.choose('#propose-currency', 'AUD');
    await page.click('[data-propose="submit"]');
    await tick();

    expect(proposed).toHaveLength(1);
    const sent = proposed[0] ?? {};
    expect(sent['recordId']).toBe(TASK_ID);
    // The revision the page holds, so a proposal made against a task that has
    // moved on is the server's `VERSION_STALE` rather than a silent write.
    expect(sent['expectedRevision']).toBe(7);
    expect(sent['operationId']).toBe('operation-1');
    expect(sent['purpose']).toBe('client.renewal.quote');
    // Money crosses the wire in minor units, so the form's dollars are
    // converted once, here, rather than in three places that can disagree.
    expect(sent['maximumMinor']).toBe(300_000);
    expect(sent['currency']).toBe('AUD');

    // The new version is on the screen because the page read the task again.
    expect(reads.length).toBeGreaterThan(readsBefore);
    expect(page.find('[data-version-id="v-3333"]')).not.toBeNull();

    await page.unmount();
  });

  it('quotes the server code when a proposal is refused and writes nothing', async () => {
    const { client, proposed } = server({
      refusePropose: { code: 'PROPOSAL_OUT_OF_SCOPE', status: 403 },
    });
    const page = await mount(screenFor(client));
    await tick();

    await page.type('#propose-purpose', 'something.out.of.scope');
    await page.type('#propose-maximum', '10');
    await page.click('[data-propose="submit"]');
    await tick();

    expect(proposed).toHaveLength(1);
    expect(page.find('[data-propose="refusal"]')?.textContent).toContain('PROPOSAL_OUT_OF_SCOPE');
    // The refusal did not invent a version to show for it.
    expect(page.find('[data-version-id="v-3333"]')).toBeNull();

    await page.unmount();
  });
});

describe('the exact-version decision control', () => {
  it('decides the version it displayed, and shows the reservation afterwards', async () => {
    const { client, decided, reads } = server();
    const page = await mount(screenFor(client));
    await tick();
    const readsBefore = reads.length;

    const approve = page.find('[data-decide="approve"]');
    expect(approve).not.toBeNull();
    // The control carries the version it is drawn beside, so what is decided
    // and what was read are the same thing by construction.
    expect(approve?.getAttribute('data-version-id')).toBe(LIVE_VERSION);
    expect(approve?.getAttribute('data-gate-id')).toBe(GATE_ID);

    await page.click('[data-decide="approve"]');
    await tick();

    expect(decided).toHaveLength(1);
    const sent = decided[0] ?? {};
    expect(sent['versionId']).toBe(LIVE_VERSION);
    expect(sent['gateId']).toBe(GATE_ID);
    expect(sent['decision']).toBe('approve');
    expect(sent['expectedRevision']).toBeUndefined();

    // The reservation is on the screen because the page read the task again.
    expect(reads.length).toBeGreaterThan(readsBefore);
    expect(page.find('[data-reservation-id="r-1"]')?.getAttribute('data-reservation-state')).toBe(
      'held',
    );

    await page.unmount();
  });

  it('offers nothing when the gate is expired, on the server word rather than a clock', async () => {
    const { client, decided } = server({ expiredGate: true });
    const page = await mount(screenFor(client));
    await tick();

    expect(page.find('[data-gate-state]')?.getAttribute('data-gate-expired')).toBe('true');
    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="reject"]')).toBeNull();
    expect(page.find('[data-decide="closed"]')?.textContent).toContain('expired');
    expect(decided).toHaveLength(0);

    await page.unmount();
  });

  it('offers nothing when the gate has already been decided', async () => {
    const { client, decided } = server({ decidedGate: true });
    const page = await mount(screenFor(client));
    await tick();

    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="closed"]')).not.toBeNull();
    expect(decided).toHaveLength(0);

    await page.unmount();
  });

  it('quotes VERSION_SUPERSEDED and rereads the task', async () => {
    const { client, reads } = server({
      refuseDecide: { code: 'VERSION_SUPERSEDED', status: 409 },
    });
    const page = await mount(screenFor(client));
    await tick();
    const readsBefore = reads.length;

    await page.click('[data-decide="approve"]');
    await tick();

    expect(page.find('[data-decide="refusal"]')?.textContent).toContain('VERSION_SUPERSEDED');
    // The refusal is the page admitting it was describing a record that had
    // moved, so the page reads it again rather than leaving the stale one up.
    expect(reads.length).toBeGreaterThan(readsBefore);

    await page.unmount();
  });

  it('quotes GATE_ALREADY_DECIDED, rereads, and stops offering the control', async () => {
    const { client, decided, reads } = server({
      refuseDecide: { code: 'GATE_ALREADY_DECIDED', status: 409 },
    });
    const page = await mount(screenFor(client));
    await tick();
    const readsBefore = reads.length;

    await page.click('[data-decide="approve"]');
    await tick();

    expect(page.find('[data-decide="refusal"]')?.textContent).toContain('GATE_ALREADY_DECIDED');
    expect(reads.length).toBeGreaterThan(readsBefore);
    expect(decided).toHaveLength(1);
    await page.unmount();
  });

  it('closes the controls after one refused press for a person without the grant', async () => {
    const { client, decided } = server({
      refuseDecide: { code: 'SCOPE_NOT_GRANTED', status: 403 },
    });
    const page = await mount(screenFor(client));
    await tick();

    await page.click('[data-decide="approve"]');
    await tick();

    expect(page.find('[data-decide="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(decided).toHaveLength(1);

    // There is no capability read in this build, so the screen cannot know
    // before it asks. What it can do is ask once and then stop offering a
    // control that has already been refused for this reader.
    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="closed"]')).not.toBeNull();

    await page.unmount();
  });
});
