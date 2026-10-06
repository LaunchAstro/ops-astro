// SPDX-License-Identifier: AGPL-3.0-only
//
// The stub server `c52a-approvals-panel.test.tsx` draws the Workflow triggers
// panel against (C52-A): one automation, two versions, one scheduled
// activation, and each change applied to it as the real commands would, so a
// reload shows what the panel sent. It can refuse one route, refuse the
// registry, or drop the answers to the next changes it is sent.

import { OperationsClient } from '../../apps/web/src/operations/client.ts';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Approval {
  id: string;
  versionId: string;
  act: 'adopted' | 'rolled_back';
  decidedBy: string;
  revoked: boolean;
}

interface Activation {
  id: string;
  versionId: string;
  versionNumber: number;
  mode: 'scheduled';
  everyMinutes: number;
  eventKind: null;
  enabled: boolean;
  changedBy: string;
  changedAt: string;
  revision: number;
  approval: Approval | null;
}

const registryOf = (activation: Activation, name = 'Weekly report'): unknown => ({
  ok: true,
  definitions: [
    {
      id: 'd-1',
      kind: 'automation',
      name,
      versions: [1, 2].map((number) => ({
        id: `v-${String(number)}`,
        number,
        contentDigest: 'a'.repeat(64),
        contentSize: 10,
        modes: ['manual', 'scheduled'],
        releasedBy: 'p-1',
        releasedAt: '2026-09-28T00:00:00.000Z',
      })),
      activations: [activation],
    },
  ],
});

const pin = (activation: Activation, number: number, how: Approval['act']): void => {
  Object.assign(activation, {
    versionId: `v-${String(number)}`,
    versionNumber: number,
    revision: activation.revision + 1,
    approval: {
      id: `s-${String(activation.revision)}`,
      versionId: `v-${String(number)}`,
      act: how,
      decidedBy: 'p-1',
      revoked: false,
    },
  });
};

const fresh = (): Activation => ({
  id: 'a-1',
  versionId: 'v-1',
  versionNumber: 1,
  mode: 'scheduled',
  everyMinutes: 60,
  eventKind: null,
  enabled: true,
  changedBy: 'p-1',
  changedAt: '2026-09-29T00:00:00.000Z',
  revision: 3,
  approval: null,
});

/** Applies one change to the stub's activation, or answers null for an unknown route. */
function applied(activation: Activation, at: string): boolean {
  if (at.endsWith('/activation/adopt')) pin(activation, 2, 'adopted');
  else if (at.endsWith('/activation/roll_back')) pin(activation, 1, 'rolled_back');
  else if (at.endsWith('/approval/revoke') && activation.approval !== null) {
    activation.approval.revoked = true;
  } else if (at.endsWith('/activation/turn_off')) {
    Object.assign(activation, {
      enabled: false,
      approval: null,
      revision: activation.revision + 1,
    });
  } else return false;
  return true;
}

export interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
}

export function server(
  options: { readonly refuse?: string; readonly lose?: number; readonly name?: string } = {},
): Stub {
  const sent: string[] = [];
  let lose = options.lose ?? 0;
  const activation = fresh();
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/automation/registry')) {
      return options.refuse === 'registry'
        ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['ask'] }, 403)
        : json(registryOf(activation, options.name));
    }
    if (options.refuse !== undefined && at.endsWith(options.refuse)) {
      return json({ refused: true, code: 'VERSION_STALE', names: ['revision=9'], fixes: [] }, 409);
    }
    if (lose > 0) {
      // The change is not applied and the answer never arrives.
      lose -= 1;
      throw new Error('the connection dropped');
    }
    if (!applied(activation, at)) {
      return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    }
    return await Promise.resolve(
      json({ recordId: 'a-1', revision: activation.revision, detail: {} }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

export const clientOf = (fetch: typeof globalThis.fetch, businessKey = 'alpha'): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

/** Every body the stub was sent on `route`, in order. */
export const bodiesOf = (stub: Stub, route: string): readonly Record<string, unknown>[] =>
  stub.sent
    .filter((one) => one.includes(route))
    .map((one) => JSON.parse(one.slice(one.indexOf(' ') + 1)) as Record<string, unknown>);
