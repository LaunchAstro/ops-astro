// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, gap 2: no caller supplies a revision, a file or a digest. The person
// and the agent send the same four operands, and a body naming a retired one
// (`baseRevision`, `before`, `after`, `path`, `pageUrl`, `partyId`) is refused
// before anything is read, on either path, storing nothing. The storage holds
// the pins' forms, so a row written past the commands with a revision that is
// not a commit, or a digest that is not `sha256:`, is refused too.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { TEST_PIN } from './located.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Forged versions: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('forged');
}, 120_000);

const RETIRED = [
  { baseRevision: 'c0'.repeat(20) },
  { before: 'We are a friendly studio.' },
  { after: 'We are a welcoming studio.' },
  { path: 'src/pages/about.md' },
  { pageUrl: 'https://agency.example/about/' },
  { partyId: randomUUID() },
] as const;

const asked = (taskId: string) => ({
  command: 'live_correction.request',
  taskId,
  page: 'About',
  word: 'friendly',
  replacement: 'welcoming',
});

const stored = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

describe.skipIf(serverUrl === undefined)('a forged version never reaches Launch', () => {
  it('refuses a retired operand from an agent inside its delegation, storing nothing', async () => {
    const picked = await w.pickUpUnder(w.ava, `forged ${randomUUID()}`, w.partyA);
    for (const extra of RETIRED) {
      // oxlint-disable-next-line no-await-in-loop -- one body after another
      const answer = await w.world.asAgent(
        { ...asked(picked.taskId), ...extra, operationId: randomUUID() },
        picked.credential,
      );
      expect(codeOf(answer)).toBe('COMMAND_BODY_INVALID');
    }
    expect(await stored(picked.taskId)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('a forged version never reaches Launch', () => {
  it.each([
    ['a revision that is not a commit', { base_revision: 'rev-1' }],
    ['a pre-image digest that is not sha256', { pre_image_digest: 'sha256:pre' }],
    ['a version digest that is not sha256', { version_digest: 'version' }],
  ])('refuses a row written past the commands with %s', async (_name, forged) => {
    const pins = {
      base_revision: TEST_PIN.baseRevision,
      pre_image_digest: TEST_PIN.preImageDigest,
      version_digest: TEST_PIN.versionDigest,
      ...forged,
    };
    await expect(
      w.world.db.admin.execute(
        `insert into public.live_corrections
           (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
            target_path, word, replacement, page_url, pre_image_digest, base_revision, seam,
            version_id, version_digest, state, located_at)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, 'src/pages/about.md', 'friendly',
                 'welcoming', 'https://agency.example/about/', $6, $7, 'seam-forged',
                 gen_random_uuid(), $8, 'requested', now())`,
        [
          w.world.business,
          w.partyA,
          w.taskA,
          w.ava.actorId,
          w.ava.personId,
          pins.pre_image_digest,
          pins.base_revision,
          pins.version_digest,
        ],
      ),
    ).rejects.toThrow(/_form/u);
  });
});
