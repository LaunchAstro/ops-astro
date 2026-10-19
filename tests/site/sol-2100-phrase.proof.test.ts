// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readProposal, sitePlanRequest } from '../../packages/core-wire/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/index.ts';
import { c80World } from './c80-world.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
it('Sol proof, criterion 1: the existing correction request accepts the phrase approved in the site plan', async () => {
  const w = await c80World('sol2100phrase');
  const suffix = randomUUID().slice(0, 8);
  const page = `https://own-${suffix}.example/about`;
  const repository = `own/site-${suffix}`;
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    expect(
      await bindPartySite(
        tx,
        {
          partyId: null,
          repository,
          defaultBranch: 'main',
          project: `prj_${suffix}`,
          pages: [{ pageUrl: page, path: 'src/pages/about.md' }],
        },
        w.admin.actorId,
      ),
    ).toEqual({ ok: true });
  });
  const block =
    '```task\n' +
    JSON.stringify({
      action: 'site_change',
      title: 'Fix About',
      page,
      before: 'Based in Brisbane',
      after: 'Based in Townsville',
      client: 'internal',
      estimate: 15,
    }) +
    '\n```';
  const { proposal } = readProposal(block, [{ repository, page }]);
  expect(proposal?.action).toBe('create');
  const created = await w.asRaw(w.ava, {
    command: 'task.create',
    fields: { title: proposal!.title, description: proposal!.description, estimated_minutes: 15 },
  });
  if (isCommandRefusal(created)) throw new Error(created.code);
  const request = sitePlanRequest({
    id: String(created.recordId),
    description: proposal!.description,
  });
  expect(request).not.toBeNull();
  const result = await w.asRaw(w.ava, { command: 'live_correction.request', ...request });
  expect(result).not.toHaveProperty('code', 'CHANGE_ENVELOPE_EXCEEDED');
  expect(isCommandRefusal(result)).toBe(false);
});
