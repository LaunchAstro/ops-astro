// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { fourEyesWorld, type Sent } from './settings-four-eyes-world.tsx';
import type { Mounted } from './mount.tsx';

export interface PrioritySettingsWorld {
  readonly sent: Sent[];
  readonly client: OperationsClient;
  value: unknown;
  revision: number;
  caps: 'manage' | 'without-manage' | 'denied';
  next: 'ok' | 'stale';
  /** How `settings.read` answers: the rows, or a 503 or 403 with none. */
  read: 200 | 503 | 403;
  /**
   * What the next priority writes meet, in turn: `unreachable` never reaches
   * the server, `lose` is stored with its answer lost, `hold` answers when its
   * release in `held` is called. None: answered at once.
   */
  readonly fates: ('unreachable' | 'lose' | 'hold')[];
  readonly held: (() => void)[];
}

const SET_PRIORITY = '/settings/set_priority_stages';

/** A stored success by operation id, replayed as the real register does. */
function replayed(
  register: Map<string, Response>,
  world: PrioritySettingsWorld,
  parsed: Record<string, unknown>,
): Response {
  const id = String(parsed['operationId']);
  const kept = register.get(id) ?? priorityWrite(world, parsed);
  if (kept.ok) register.set(id, kept);
  return kept.clone();
}

/** The priority write as its fate has it reach this screen. */
async function fated(
  fate: PrioritySettingsWorld['fates'][number] | undefined,
  world: PrioritySettingsWorld,
  answer: () => Response,
): Promise<Response> {
  if (fate === 'unreachable') throw new TypeError('Failed to fetch');
  const response = answer();
  if (fate === 'lose') throw new TypeError('Failed to fetch');
  if (fate !== 'hold') return response;
  return await new Promise<Response>((resolve) => {
    world.held.push(() => {
      resolve(response);
    });
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function refusal(code: string): Response {
  return json(
    { refused: true, code, names: ['priority_stages'], fixes: ['Read again before changing it.'] },
    code === 'VERSION_STALE' ? 409 : 403,
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function priorityCapabilities(world: PrioritySettingsWorld, businessKey: string): Response {
  if (world.caps === 'denied') return refusal('SCOPE_NOT_GRANTED');
  return json({
    ok: true,
    personId: 'p-ada',
    businessKey,
    grants: [
      { collection: 'spend', action: 'decide' },
      ...(world.caps === 'manage' ? [{ collection: 'settings', action: 'manage' }] : []),
    ],
  });
}

function priorityRead(world: PrioritySettingsWorld): Response {
  if (world.read === 503) return json({ error: 'unavailable' }, 503);
  if (world.read === 403) return refusal('SCOPE_NOT_GRANTED');
  return json({
    ok: true,
    settings: [
      {
        key: 'priority_stages',
        value: world.value,
        valueType: 'stage_ids',
        updatedAt: '2026-10-09T06:00:00.000Z',
        updatedByActorId: 'actor-ada',
        revision: world.revision,
      },
    ],
  });
}

function priorityWrite(world: PrioritySettingsWorld, parsed: Record<string, unknown>): Response {
  const next = world.next;
  world.next = 'ok';
  if (next === 'stale') {
    world.value = ['retention'];
    world.revision += 1;
    return refusal('VERSION_STALE');
  }
  // As the writer does: a revision sent is compared, none sent writes anyway.
  const expected = parsed['expectedRevision'];
  if (expected !== undefined && expected !== world.revision) return refusal('VERSION_STALE');
  world.value = parsed['value'];
  world.revision += 1;
  return json({
    recordId: 'priority-setting-row',
    revision: world.revision,
    detail: { value: world.value, revision: world.revision },
  });
}

// Synthetic transport only. The REAL SettingsScreen/OperationsClient and
// existing React mount/four-eyes world remain the owners under test.
export function prioritySettingsWorld(businessKey = 'alpha'): PrioritySettingsWorld {
  const legacy = fourEyesWorld({ value: 500, revision: 7 });
  const register = new Map<string, Response>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const at = input instanceof Request ? input.url : String(input);
    const parsed: unknown = JSON.parse(String(init?.body ?? '{}'));
    if (!object(parsed)) throw new Error('Priority fixture received a non-object request');
    const fate = at.endsWith(SET_PRIORITY) ? world.fates.shift() : undefined;
    if (fate === 'unreachable') return await fated(fate, world, () => new Response());
    world.sent.push({ at, body: parsed });
    if (at.endsWith('/session/capabilities')) return priorityCapabilities(world, businessKey);
    if (at.endsWith('/settings/read')) return priorityRead(world);
    if (at.endsWith(SET_PRIORITY))
      return await fated(fate, world, () => replayed(register, world, parsed));
    // Established fixture handles the untouched legacy settings/cap children.
    return await legacy.fetch(input, init);
  };
  const world: PrioritySettingsWorld = {
    sent: [],
    value: ['trust'],
    revision: 7,
    caps: 'manage',
    next: 'ok',
    read: 200,
    fates: [],
    held: [],
    client: new OperationsClient({ origin: '', businessKey, signedIn: true, fetch }),
  };
  return world;
}

export function priorityScreen(
  world: PrioritySettingsWorld,
  grantKey = 'alpha:ada:0',
): ReactElement {
  return (
    <SettingsScreen client={world.client} grantKey={grantKey} storage={window.sessionStorage} />
  );
}
export function priorityWrites(world: PrioritySettingsWorld): readonly Sent[] {
  return world.sent.filter((one) => one.at.endsWith(SET_PRIORITY));
}
export function priorityInput(page: Mounted, id: string): HTMLInputElement {
  const found = page.find(`[data-settings="priority-stages"] input[value="${id}"]`);
  if (!(found instanceof HTMLInputElement)) throw new Error(`No priority checkbox for ${id}`);
  return found;
}
export function prioritySave(page: Mounted): HTMLButtonElement {
  const found = page.find('[data-settings="save-priority"]');
  if (!(found instanceof HTMLButtonElement)) throw new Error('No real Settings priority Save');
  return found;
}
export function choosePriority(page: Mounted, id: string): Promise<void> {
  return page.click(`[data-settings="priority-stages"] input[value="${id}"]`);
}
