// SPDX-License-Identifier: AGPL-3.0-only
//
// Row R4X of the surface-final group (`surface-final.mjs`), which runs it
// after D03 and D05: the external party, signed in through GoTrue by the form.
// The shared task reads as `sharedTask`, the sibling task and the board are
// refused, and after `grant.revoke` the shared task is refused too. Every read
// is made by the web's own `operations/client.ts` inside the page.

import { randomUUID } from 'node:crypto';
import { VIEWPORT, record, shot, signIn, throughClient, users } from './harness.mjs';
import { callApi, sharedTask, tokenOf } from './i10-open-page.mjs';

const step = (what) => {
  process.stderr.write(`surface-final: ${what}\n`);
};

/** A refusal as `CODE [names]`, or the whole answer when it is not one. */
export const refusalOf = (result) =>
  'refused' in result ? `${result.code} [${result.names.join(', ')}]` : JSON.stringify(result);

export async function casesR4X(run, browser) {
  const { database, admin, alpha, stamp } = run;
  // The seed builds the external address rather than writing it; so does this.
  const external = users.find((user) => user.role === 'external')?.email;
  if (external === undefined) throw new Error('no role: external entry in synthetic-users.json');
  const adaToken = await tokenOf('ada@alpha.local');
  const shared = await sharedTask(
    { database, admin, alpha, adaToken },
    external,
    `SF shared ${stamp}`,
  );
  const sibling = await callApi(adaToken, 'task.create', {
    operationId: randomUUID(),
    fields: { title: `SF sibling ${stamp}` },
  });
  const siblingId = String(sibling.body.recordId);

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    step('ext signs in through the form (GoTrue password grant)');
    await signIn(page, external, 'alpha');
    const read = async (name, body) =>
      (await throughClient(page, { read: true, name, body })).result;

    const open = await read('task.read', { recordId: shared.recordId });
    const keys = open.ok === true ? Object.keys(open.value).toSorted().join(',') : refusalOf(open);
    record({
      case: 'R4X shared task reads shared view',
      action: 'task.read of the shared task, in the page, as ext',
      observed: `keys ${keys}`,
      ok: open.ok === true && keys === 'ok,sharedTask',
    });

    const siblingRead = await read('task.read', { recordId: siblingId });
    const board = await read('task.board', { board: null });
    await shot(page, 'R4X-sibling-board');
    record({
      case: 'R4X sibling task refused',
      action: 'task.read of an unshared task in the same business, as ext',
      observed: refusalOf(siblingRead),
      ok: 'refused' in siblingRead && !JSON.stringify(siblingRead).includes('SF sibling'),
    });
    record({
      case: 'R4X board refused',
      action: 'task.board, as ext',
      observed: refusalOf(board),
      ok: 'refused' in board && !JSON.stringify(board).includes('SF shared'),
    });

    const grantState = async () =>
      (
        await admin.execute(
          'select revoked_at is not null as revoked from public.grants where id = $1',
          [shared.grantId],
        )
      )[0]?.revoked;
    const revoked = await callApi(adaToken, 'grant.revoke', {
      operationId: randomUUID(),
      grantId: shared.grantId,
    });
    const after = await read('task.read', { recordId: shared.recordId });
    await shot(page, 'R4X-after-revoke');
    record({
      case: 'R4X revoked share refused next read',
      action: 'grant.revoke over HTTP, then task.read in the page',
      observed: `grant.revoke ${String(revoked.status)}; grant revoked in db ${String(await grantState())}; next read ${refusalOf(after)}`,
      ok:
        revoked.status === 200 &&
        (await grantState()) === true &&
        'refused' in after &&
        !JSON.stringify(after).includes('sharedTask'),
    });
  } finally {
    await context.close();
  }
}
