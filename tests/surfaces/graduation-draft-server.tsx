// SPDX-License-Identifier: AGPL-3.0-only
//
// A stub server for the standing approval form's filings (#1427), kept as the
// command keeps them: each operation keeps its first answer, and each draft id
// is bound to the values it first filed, so a retry of a bound draft with the
// same values is a repeat and one with other values is refused naming
// `draftId`. Answers can be lost on the way there or back, or held.

import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { GraduationRegion } from '../../apps/web/src/screens/connections/graduation.tsx';
import type {
  ConnectionGraduationResult,
  MandateView,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

export const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const SEEDED: MandateView = {
  id: 'm-seed',
  clientId: 'k-a',
  classes: ['*'],
  refuses: false,
  ceiling: { amountMinor: 50_000, currency: 'AUD' },
  expiresAt: '2030-10-29T12:00:00Z',
  expired: false,
  label: 'Seeded approval',
  graduationClass: null,
  authoredBy: 'actor-1',
  createdAt: '2026-09-28T12:00:00Z',
  revision: 1,
};

export interface Stub {
  readonly fetch: typeof globalThis.fetch;
  /** Every command body sent, with its path. */
  readonly sent: { readonly at: string; readonly body: Record<string, unknown> }[];
  /** The mandates the server holds now, revoked ones left out. */
  readonly held: () => readonly MandateView[];
}

export interface StubOptions {
  /** Paths whose first call is applied, then its answer lost on the way back. */
  readonly loseAfter?: readonly string[];
  /** Paths whose first call is lost on the way there, applying nothing. */
  readonly loseBefore?: readonly string[];
  /** Commands wait on this before they are answered. */
  readonly hold?: Promise<void>;
}

const valuesOf = (body: Record<string, unknown>): string =>
  JSON.stringify([
    body['clientId'],
    body['classes'],
    body['refuses'],
    body['ceiling'],
    body['expiresAt'],
    body['label'],
  ]);

/** The server as the stub keeps it: an operation register, draft bindings and mandates. */
// eslint-disable-next-line max-lines-per-function -- the stub server, in one place
export function stubServer(options: StubOptions = {}): Stub {
  const sent: Stub['sent'] = [];
  const mandates = new Map<string, MandateView>([[SEEDED.id, SEEDED]]);
  const ended = new Set<string>();
  const register = new Map<string, Response>();
  const drafts = new Map<string, { readonly values: string; readonly mandateId: string }>();
  const lostAfter = new Set<string>();
  const lostBefore = new Set<string>();
  const region = (): ConnectionGraduationResult => ({
    ok: true,
    clients: [
      { id: 'k-a', label: 'Client A', scopes: ['*', 'social.post'] },
      { id: 'k-b', label: 'Client B', scopes: ['*', 'social.post'] },
    ],
    rows: [],
    mandates: [...mandates.values()].filter((one) => !ended.has(one.id)),
  });
  const file = (body: Record<string, unknown>): Response => {
    const draftId = String(body['draftId']);
    const bound = drafts.get(`${String(body['clientId'])}:${draftId}`);
    if (bound !== undefined && bound.values !== valuesOf(body)) {
      return json(
        { refused: true, code: 'FIELD_VALUE_INVALID', names: ['draftId'], fixes: ['one draft'] },
        422,
      );
    }
    if (bound !== undefined) {
      return json({
        recordId: bound.mandateId,
        revision: 1,
        detail: { mandateId: bound.mandateId, repeat: true },
      });
    }
    const id = `m-filed-${mandates.size}`;
    mandates.set(id, {
      ...SEEDED,
      id,
      clientId: String(body['clientId']),
      label: String(body['label']),
      expiresAt: String(body['expiresAt']),
    });
    drafts.set(`${String(body['clientId'])}:${draftId}`, { values: valuesOf(body), mandateId: id });
    return json({ recordId: id, revision: 1, detail: { mandateId: id } });
  };
  const command = (at: string, body: Record<string, unknown>): Response => {
    const operation = String(body['operationId']);
    const kept = register.get(operation);
    if (kept !== undefined) return kept.clone();
    let reply: Response;
    if (at.endsWith('/mandate/file')) reply = file(body);
    else if (at.endsWith('/mandate/revoke')) {
      ended.add(String(body['mandateId']));
      reply = json({
        recordId: body['mandateId'],
        revision: 2,
        detail: { mandateId: body['mandateId'], state: 'revoked' },
      });
    } else reply = json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    register.set(operation, reply.clone());
    return reply;
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/connection/graduation')) return json(region());
    if (!/\/(mandate|graduation)\/[a-z]+$/u.test(at)) {
      if (at.endsWith('/connection/fleet')) {
        return json({
          ok: true,
          connections: [],
          counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
        });
      }
      return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    await options.hold;
    const path = at.slice(at.indexOf('/', at.indexOf('/b/') + 3));
    if (options.loseBefore?.includes(path) === true && !lostBefore.has(path)) {
      lostBefore.add(path);
      throw new TypeError('Failed to fetch');
    }
    const reply = command(at, body);
    if (options.loseAfter?.includes(path) === true && !lostAfter.has(path)) {
      lostAfter.add(path);
      throw new TypeError('Failed to fetch');
    }
    return reply;
  }) as typeof globalThis.fetch;
  return {
    fetch,
    sent,
    held: () => [...mandates.values()].filter((one) => !ended.has(one.id)),
  };
}

const opened: Mounted[] = [];

/** Unmount every page a case opened. */
export async function unmountOpened(): Promise<void> {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
}

/** Keep `page` to be unmounted after the case. */
export function opens(page: Mounted): Mounted {
  opened.push(page);
  return page;
}

export async function regionOn(stub: Stub): Promise<Mounted> {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: stub.fetch,
  });
  const page = await mount(<GraduationRegion client={client} grantKey="alpha:person-a" />);
  opens(page);
  await tick();
  return page;
}

export async function fill(page: Mounted, label = 'Approve posts'): Promise<void> {
  await page.type('[data-mandate-label]', label);
  await page.type('[data-mandate-ceiling]', '500');
  await page.type('[data-mandate-expiry]', '2030-10-31');
}

export const filings = (stub: Stub): Record<string, unknown>[] =>
  stub.sent.filter((one) => one.at.endsWith('/mandate/file')).map((one) => one.body);

export const valueOf = (page: Mounted, selector: string): string | undefined =>
  page.host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value;
