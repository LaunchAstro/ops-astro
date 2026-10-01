// SPDX-License-Identifier: AGPL-3.0-only
//
// C33: released versions and the activations pinned to them, against a real database (U36, #483). Each case is named after
// the supporting checklist line it proves. The commands, the read and the
// screen are the next increment; what is held on AW-01 and AW-02 is in
// `c33-held.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeActivation,
  insertActivation,
  insertDefinition,
  readActivation,
  readVersion,
  type ActivationRow,
  type DefinitionVersionRow,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createAutomationWorld, DIGEST, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 versions and activations', () => {
  let w: AutomationWorld;

  beforeAll(async () => {
    w = await createAutomationWorld('c33v');
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('C33 version immutable: a released version keeps its bytes pin, inputs and modes, whoever asks', async () => {
    const version = await w.release(['manual', 'scheduled']);
    expect(version.number).toBeGreaterThanOrEqual(1);
    await expect(
      w.inAlpha((tx) =>
        tx.query('update public.definition_versions set content_size = 1 where id = $1', [
          version.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      w.db.admin.execute('update public.definition_versions set modes = $2 where id = $1', [
        version.id,
        ['manual', 'scheduled', 'event'],
      ]),
    ).rejects.toThrow(/definition_versions: version .* never changes/u);
    await expect(
      w.db.admin.execute('delete from public.definition_versions where id = $1', [version.id]),
    ).rejects.toThrow(/definition_versions: version .* never changes/u);
    const again = await w.inAlpha<DefinitionVersionRow | null>((tx) => readVersion(tx, version.id));
    expect(again).toEqual(version);
    expect(again?.contentDigest).toBe(DIGEST);
    expect(again?.contentSize).toBe(1234);
    // The next release is a new version with the next number, never an edit.
    const next = await w.release(['manual']);
    expect(next.number).toBe(version.number + 1);
    expect(next.id).not.toBe(version.id);
  });

  it('C33 pinned version: an activation always names a version of its own definition', async () => {
    const version = await w.release(['manual']);
    const before = await w.count('select count(*) as n from public.activations');
    await expect(
      w.db.admin.execute(
        `insert into public.activations
           (business_id, id, definition_id, version_id, mode, changed_by_actor_id)
         values ($1, $2, $3, null, 'manual', $4)`,
        [w.alpha, randomUUID(), w.definition, w.admin.actorId],
      ),
    ).rejects.toThrow(/null value in column "version_id"/u);
    const otherDefinition = await w.inAlpha<string>((tx) =>
      insertDefinition(tx, { kind: 'skill', name: 'Another', actorId: w.admin.actorId }),
    );
    await expect(
      w.db.admin.execute(
        `insert into public.activations
           (business_id, id, definition_id, version_id, mode, changed_by_actor_id)
         values ($1, $2, $3, $4, 'manual', $5)`,
        [w.alpha, randomUUID(), otherDefinition, version.id, w.admin.actorId],
      ),
    ).rejects.toThrow(/activations_version_fkey/u);
    // Another business's version is not there to pin to.
    const pinned = await w.db.app.withBusiness(w.bravo, (tx) =>
      insertActivation(tx, {
        versionId: version.id,
        mode: 'manual',
        everyMinutes: null,
        eventKind: null,
        enabled: false,
        actorId: w.bravoAdmin.actorId,
      }),
    );
    expect(pinned).toBeNull();
    expect(await w.count('select count(*) as n from public.activations')).toBe(before);
  });

  it('C33 mode not permitted refused: a mode the pinned version does not permit is never written', async () => {
    const manualOnly = await w.release(['manual']);
    const before = await w.count('select count(*) as n from public.activations');
    await expect(w.activate(manualOnly, 'scheduled')).rejects.toThrow(
      /does not permit mode scheduled/u,
    );
    expect(await w.count('select count(*) as n from public.activations')).toBe(before);
    const manual = await w.activate(manualOnly, 'manual');
    await expect(
      w.inAlpha((tx) =>
        changeActivation(tx, manual.id, manual.revision, {
          versionId: manualOnly.id,
          mode: 'event',
          everyMinutes: null,
          eventKind: 'invoice.paid',
          enabled: true,
          actorId: w.admin.actorId,
        }),
      ),
    ).rejects.toThrow(/does not permit mode event/u);
    expect(await w.inAlpha((tx) => readActivation(tx, manual.id))).toEqual(manual);
    // Re-pinning to a version that permits the mode is the way to change it.
    const both = await w.release(['manual', 'event']);
    const moved = await w.inAlpha<ActivationRow | null>((tx) =>
      changeActivation(tx, manual.id, manual.revision, {
        versionId: both.id,
        mode: 'event',
        everyMinutes: null,
        eventKind: 'invoice.paid',
        enabled: true,
        actorId: w.admin.actorId,
      }),
    );
    expect(moved).toMatchObject({
      versionId: both.id,
      mode: 'event',
      revision: manual.revision + 1,
    });
  });
});
