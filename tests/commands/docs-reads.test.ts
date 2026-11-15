// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the thin slice (#2493 piece 2): the business's folder tree and one page, read under
// `docs:read` at the business against a real database. Each read is the business's own: another
// business's page is `NOT_FOUND` and never named, a `docs:read` grant held at one client reads
// nothing, and a person without `docs:read` reads nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';

const CANARY = `canary-${randomUUID()}`;

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('docs-reads: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dr');
  // Ada writes and reads docs; Noah reads only; the client-A member holds `docs:read` at one
  // client; the task-only member holds no docs key.
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.ada, 'read', WHOLE, false, 'docs');
    await grantTo(tx, w.noah, 'read', WHOLE, false, 'docs');
    await grantTo(tx, w.clientA, 'read', { kind: 'party', id: randomUUID() }, false, 'docs');
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await grantTo(tx, w.bravoOwner, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.bravoOwner, 'read', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const idOf = (answer: CommandResult, field: string): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as Record<string, unknown>)[field]);
};

async function planted(business: BusinessId, member: Member, title: string, body: string) {
  const folderId = idOf(
    await w.as(business, member, { command: 'docs.create_folder', name: `${title} folder` }),
    'folderId',
  );
  const childId = idOf(
    await w.as(business, member, {
      command: 'docs.create_folder',
      name: `${title} child`,
      parentId: folderId,
    }),
    'folderId',
  );
  const pageId = idOf(
    await w.as(business, member, { command: 'docs.create_page', folderId: childId, title, body }),
    'pageId',
  );
  return { folderId, childId, pageId };
}

const read = async (business: BusinessId, member: Member, request: Record<string, unknown>) => {
  const answer = await executeRead(w.db.app, business, member.presented, request as never);
  return { answer: answer as unknown as CommandResult, text: JSON.stringify(answer) };
};

const row = (name: string) => {
  const found = COMMAND_SURFACE.find((each) => each.name === name);
  return [found?.kind, found?.collection, found?.action, found?.authorisedOn, found?.agent];
};

describe('docs reads are declared', () => {
  it('docs.tree and docs.page are docs:read on the business, for people until the agent path', () => {
    expect(row('docs.tree')).toStrictEqual(['read', 'docs', 'read', 'business', 'never']);
    expect(row('docs.page')).toStrictEqual(['read', 'docs', 'read', 'business', 'never']);
  });
});

live('docs reads', () => {
  it('docs.tree lists the business folders by parent and each page title, never a body', async () => {
    const own = await planted(w.alpha, w.ada, 'Onboarding', 'the body text');
    const { answer, text } = await read(w.alpha, w.noah, { read: 'docs.tree' });
    expect(codeOf(answer)).toBe('not-a-refusal');
    const tree = answer as unknown as {
      folders: { id: string; name: string; parentId: string | null }[];
      pages: { id: string; folderId: string; title: string; version: number }[];
    };
    expect(tree.folders).toContainEqual({
      id: own.folderId,
      name: 'Onboarding folder',
      parentId: null,
    });
    expect(tree.folders).toContainEqual({
      id: own.childId,
      name: 'Onboarding child',
      parentId: own.folderId,
    });
    expect(tree.pages).toContainEqual({
      id: own.pageId,
      folderId: own.childId,
      title: 'Onboarding',
      version: 1,
    });
    expect(text).not.toContain('the body text');
  });

  it('docs.page answers the title, Markdown body and version a reader saves against', async () => {
    const own = await planted(w.alpha, w.ada, 'Handbook', '# Handbook\n\nFirst line.');
    const updated = await w.as(w.alpha, w.ada, {
      command: 'docs.update_page',
      pageId: own.pageId,
      expectedVersion: 1,
      body: '# Handbook\n\nSecond line.',
    });
    expect(codeOf(updated)).toBe('not-a-refusal');
    const { answer } = await read(w.alpha, w.noah, { read: 'docs.page', pageId: own.pageId });
    expect(codeOf(answer)).toBe('not-a-refusal');
    const { page } = answer as unknown as { page: Record<string, unknown> };
    expect(page).toMatchObject({
      id: own.pageId,
      folderId: own.childId,
      title: 'Handbook',
      body: '# Handbook\n\nSecond line.',
      version: 2,
    });
  });

  it('a missing page is NOT_FOUND on its field', async () => {
    const { answer } = await read(w.alpha, w.noah, { read: 'docs.page', pageId: randomUUID() });
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(isCommandRefusal(answer) ? answer.names : []).toStrictEqual(['pageId']);
  });
});

live('docs reads: isolation', () => {
  it('another business: its page is NOT_FOUND as a missing one is, and its tree names none of it', async () => {
    const foreign = await planted(w.bravo, w.bravoOwner, CANARY, `body ${CANARY}`);
    const page = await read(w.alpha, w.ada, { read: 'docs.page', pageId: foreign.pageId });
    expect(codeOf(page.answer)).toBe('NOT_FOUND');
    expect(isCommandRefusal(page.answer) ? page.answer.names : []).toStrictEqual(['pageId']);
    expect(page.text).not.toContain(CANARY);
    const tree = await read(w.alpha, w.ada, { read: 'docs.tree' });
    expect(codeOf(tree.answer)).toBe('not-a-refusal');
    expect(tree.text).not.toContain(CANARY);
    expect(tree.text).not.toContain(foreign.folderId);
    expect(tree.text).not.toContain(foreign.pageId);
  });

  it('another client: a docs:read grant held at one client reads no tree and no page', async () => {
    const own = await planted(w.alpha, w.ada, `${CANARY}-client`, `body ${CANARY}`);
    for (const request of [{ read: 'docs.tree' }, { read: 'docs.page', pageId: own.pageId }]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const { answer, text } = await read(w.alpha, w.clientA, request);
      expect(codeOf(answer), request.read).toBe('SCOPE_NOT_GRANTED');
      expect(text).not.toContain(CANARY);
    }
  });

  it('another person: a member without docs:read reads no tree and no page', async () => {
    const own = await planted(w.alpha, w.ada, `${CANARY}-person`, `body ${CANARY}`);
    for (const request of [{ read: 'docs.tree' }, { read: 'docs.page', pageId: own.pageId }]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const { answer, text } = await read(w.alpha, w.taskOnly, request);
      expect(codeOf(answer), request.read).toBe('SCOPE_NOT_GRANTED');
      expect(text).not.toContain(CANARY);
    }
  });
});
