// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #414: an agent credential (API-2) writes a comment as its agent
// actor through the person handler, and the comment records the person the
// credential acts for, as a delegation's does, so its words are someone's to
// correct and the credential that wrote them still can.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { agentPath, bearer, call, createWorld, personPath, type World } from './world.ts';

let world: World;
beforeAll(async () => {
  world = await createWorld('credential_comment_person');
}, 180_000);
afterAll(async () => {
  await world?.close();
});

const asAda = (name: CommandName, body: Record<string, unknown>) =>
  call(world.api, personPath('alpha', pathOf(name)), body, bearer(world.ada.token));

it("records the credential's person on its comment, and the credential edits it", async () => {
  const made = await asAda('task.create', {
    operationId: randomUUID(),
    fields: { title: 'A task the credential comments on' },
  });
  const issued = await asAda('credential.issue', {
    operationId: randomUUID(),
    scope: [{ collection: 'task', action: 'comment' }],
    purpose: 'credential comment person',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const credential = (issued.body['detail'] as { readonly credential?: unknown } | undefined)
    ?.credential;
  if (typeof credential !== 'string') throw new Error('credential missing');
  const asAgent = (name: CommandName, body: Record<string, unknown>) =>
    call(
      world.api,
      agentPath('alpha', pathOf(name)),
      {
        operationId: randomUUID(),
        recordId: made.body['recordId'],
        expectedRevision: made.body['revision'],
        ...body,
      },
      bearer(credential),
    );
  const posted = await asAgent('task.comment', {
    body: 'Written by the credential',
    audience: 'internal',
  });
  const commentId = (posted.body['detail'] as { readonly commentId: string }).commentId;
  const edited = await asAgent('task.edit_comment', { commentId, body: 'Corrected by it' });
  const [row] = await world.db.admin.execute<{ person: string | null; body: string }>(
    `select data ->> 'on_behalf_of' as person, data ->> 'body' as body from public.records where id = $1`,
    [commentId],
  );
  expect({ edited: edited.status, row }).toEqual({
    edited: 200,
    row: { person: world.ada.personId, body: 'Corrected by it' },
  });
});
