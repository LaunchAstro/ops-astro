// SPDX-License-Identifier: AGPL-3.0-only
//
// The activation history's cases over C33's route world (`registry-world.ts`):
// one activation taken through each change a person makes, with an occurrence
// whose run started between them, and the history read back through the real
// route, a page at a time.

import { expect } from 'vitest';
import { claimOccurrence, dispatchOccurrence } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import type { Answer } from '../api/fixture.ts';
import { starter } from './firing.ts';
import { detail, type RegistryWorld } from './registry-world.ts';

/** One history entry as the route sends it; the cases pin the fields they mean. */
export interface Entry {
  readonly kind: 'occurrence' | 'change';
  readonly id: string;
  readonly at: string;
  readonly [field: string]: unknown;
}

export interface HistoryPage {
  readonly entries: readonly Entry[];
  readonly next: string | null;
}

/** One page of an activation's history as `who` asks it, which must be answered. */
export async function historyPage(
  w: RegistryWorld,
  who: Member,
  activationId: string,
  cursor?: string,
  business = 'alpha',
): Promise<HistoryPage> {
  const answer = await askHistory(w, who, activationId, cursor, business);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as unknown as HistoryPage;
}

export async function askHistory(
  w: RegistryWorld,
  who: Member,
  activationId: unknown,
  cursor?: string,
  business = 'alpha',
): Promise<Answer> {
  const body = cursor === undefined ? { activationId } : { activationId, cursor };
  return await w.as(who, 'automation.history', body, business);
}

/** Every page of an activation's history, in order, following each page's cursor. */
export async function wholeHistory(
  w: RegistryWorld,
  who: Member,
  activationId: string,
): Promise<HistoryPage[]> {
  const pages: HistoryPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each page names the next
    const page = await historyPage(w, who, activationId, cursor);
    pages.push(page);
    if (page.next === null) return pages;
    cursor = page.next;
  }
}

/** The activation's current revision, as the registry shows it. */
export async function revisionOf(w: RegistryWorld, activationId: string): Promise<number> {
  const shown = (await w.registry(w.admin)).definitions
    .flatMap((one) => one.activations)
    .find((one) => one.id === activationId);
  return shown?.revision ?? 0;
}

/** A command the admin sends that must be applied; answers its detail. */
export async function applied(
  w: RegistryWorld,
  name: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const answer = await w.as(w.admin, name, body);
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(200);
  return detail(answer);
}

/** An activation scheduled hourly on version 1 of a definition with two versions. */
export async function scheduledOnFirst(w: RegistryWorld): Promise<{
  readonly activationId: string;
  readonly first: string;
  readonly second: string;
}> {
  const { definitionId, versionId: first } = await w.define(['manual', 'scheduled']);
  const on = await applied(w, 'activation.change', {
    versionId: first,
    mode: 'scheduled',
    everyMinutes: 60,
    enabled: true,
  });
  const next = await w.release({ definitionId, modes: ['manual', 'scheduled'] });
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  return {
    activationId: String(on['activationId']),
    first,
    second: String(detail(next)['versionId']),
  };
}

/** One occurrence of the activation at `dueAt`, claimed and dispatched by the business's worker. */
export async function fireAt(w: RegistryWorld, activationId: string, dueAt: Date): Promise<string> {
  const { db, business } = w.controls.fixture;
  const counting = await starter(db, business);
  return await db.app.withBusiness(business, async (tx) => {
    const claim = await claimOccurrence(tx, activationId, { dueAt });
    if (claim.kind !== 'claimed') throw new Error(`the claim answered ${claim.kind}`);
    await dispatchOccurrence(tx, claim.occurrence.id, counting.start);
    return claim.occurrence.id;
  });
}

/** The person's name as the people table holds it. */
export async function nameOf(w: RegistryWorld, who: Member): Promise<string> {
  const rows = await w.controls.fixture.db.admin.execute<{ readonly name: string }>(
    'select display_name as name from public.people where id = $1',
    [who.personId],
  );
  return String(rows[0]?.name);
}
