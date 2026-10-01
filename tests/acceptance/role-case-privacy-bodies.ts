// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for C81's commands, the legal documents and
// the privacy records, split from role-case-bodies.ts to keep that file under
// the line limit. The admin holds `privacy:manage`, as the owner does.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

type PrivacyCommand = Extract<
  CommandName,
  | 'legal.draft_version'
  | 'legal.approve_version'
  | 'legal.publish_version'
  | 'privacy.set_overseas_service'
  | 'privacy.set_data_class'
  | 'privacy.draft_breach_notices'
  | 'privacy.record_incident'
>;

/** What these recipes need from the world: `BodyContext`'s person. */
interface PrivacyContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

/** Legal document versions drafted by the matrix, each under a label of its own. */
let legalDrafts = 0;

/** A fresh breach-runbook version drafted by the admin, `approved` or not (C81). */
async function legalVersion(
  context: PrivacyContext,
  approved: boolean,
): Promise<{ versionId: string; digest: string }> {
  legalDrafts += 1;
  const drafted = await context.asPerson('legal.draft_version', {
    document: 'breach-runbook',
    version: `${String(Math.floor(legalDrafts / 1000) + 1)}.${String(legalDrafts % 1000)}`,
    body: 'The matrix drafts a made-up runbook.',
  });
  if (drafted.code !== 'ok') throw new Error(`matrix: legal draft refused ${drafted.code}`);
  const detail = drafted.body['detail'] as Record<string, unknown>;
  const version = { versionId: String(detail['versionId']), digest: String(detail['digest']) };
  if (approved) {
    const done = await context.asPerson('legal.approve_version', version);
    if (done.code !== 'ok') throw new Error(`matrix: legal approval refused ${done.code}`);
  }
  return version;
}

/** A made-up runbook with a template the drill can fill (C81). */
const DRILL_RUNBOOK = [
  '# The matrix drafts a made-up runbook',
  '',
  '## Template: notice to affected people',
  '',
  '> Subject: A made-up notice',
  '> Dear `<name>`, on `<date>` we found that `<plain description>`.',
  '> Kinds: `<kinds>`. Done: `<containment>`. Do: `<steps>`.',
  '',
].join('\n');

/** An incident and a published runbook, and the drill's body for them (C81). */
async function drillBody(context: PrivacyContext): Promise<Record<string, unknown>> {
  legalDrafts += 1;
  const drafted = await context.asPerson('legal.draft_version', {
    document: 'breach-runbook',
    version: `${String(Math.floor(legalDrafts / 1000) + 50)}.${String(legalDrafts % 1000)}`,
    body: DRILL_RUNBOOK,
  });
  if (drafted.code !== 'ok') throw new Error(`matrix: drill runbook refused ${drafted.code}`);
  const detail = drafted.body['detail'] as Record<string, unknown>;
  const version = { versionId: String(detail['versionId']), digest: String(detail['digest']) };
  const approved = await context.asPerson('legal.approve_version', version);
  if (approved.code !== 'ok') throw new Error(`matrix: drill approval refused ${approved.code}`);
  const published = await context.asPerson('legal.publish_version', {
    versionId: version.versionId,
  });
  if (published.code !== 'ok') throw new Error(`matrix: drill publish refused ${published.code}`);
  const recorded = await context.asPerson('privacy.record_incident', {
    whatHappened: 'The matrix records a made-up incident to drill.',
    foundAt: new Date(Date.now() - 60_000).toISOString(),
    foundBy: 'The matrix',
    affected: 'Nobody; it is made up.',
    informationKinds: ['other'],
  });
  if (recorded.code !== 'ok') throw new Error(`matrix: drill incident refused ${recorded.code}`);
  return {
    incidentId: String((recorded.body['detail'] as Record<string, unknown>)['incidentId']),
    oaic: { name: 'A made-up regulator', address: 'regulator@example.test' },
    people: [{ name: 'A made-up person', address: 'person@example.test' }],
    containment: 'Nothing real happened.',
    steps: 'Nothing to do.',
  };
}

const OVERSEAS_SERVICE = {
  service: 'A made-up service the matrix sets',
  receives: 'nothing real',
  where: 'nowhere',
  trainsOnIt: 'no',
  contract: 'none',
  toConfirm: false,
  inUse: true,
};

const DATA_CLASS = {
  dataClass: 'A made-up class the matrix sets',
  purpose: 'nothing real',
  disclosures: 'no one',
  retention: 'a day',
  deletion: 'deleted',
  inUse: true,
};

/** The body `createPositiveBody` sends for one of C81's commands. */
export async function privacyBody(
  name: PrivacyCommand,
  context: PrivacyContext,
): Promise<{ readonly body: Record<string, unknown> }> {
  switch (name) {
    case 'legal.draft_version':
      return {
        body: {
          document: 'breach-runbook',
          version: `0.${String((legalDrafts += 1))}`,
          body: 'The matrix drafts a made-up runbook.',
        },
      };
    case 'legal.approve_version':
      return { body: await legalVersion(context, false) };
    case 'legal.publish_version':
      return { body: { versionId: (await legalVersion(context, true)).versionId } };
    case 'privacy.set_overseas_service':
      return { body: OVERSEAS_SERVICE };
    case 'privacy.set_data_class':
      return { body: DATA_CLASS };
    // C81's breach drill: an incident of the admin's, and a runbook whose
    // template the drill can fill, published as the admin (who holds
    // `privacy:manage`, as the owner does).
    case 'privacy.draft_breach_notices':
      return { body: await drillBody(context) };
    case 'privacy.record_incident':
      return {
        body: {
          whatHappened: 'The matrix records a made-up incident.',
          foundAt: new Date(Date.now() - 60_000).toISOString(),
          foundBy: 'The matrix',
          affected: 'Nobody; it is made up.',
          informationKinds: ['other'],
        },
      };
  }
}
