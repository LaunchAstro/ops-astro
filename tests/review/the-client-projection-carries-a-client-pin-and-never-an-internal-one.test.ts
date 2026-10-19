// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one proof: two pins, the client read and the team read, top to bottom */
//
// C35 (#2012): a pin is a comment, so the client sees it through the task's client
// projection, the allowlist of client comments in shared fields. A client pin is projected
// with its anchor; an internal pin, its body, anchor and id, never reaches the client's read.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pin projection: DATABASE_URL is unset.');

const INTERNAL_MARKER = 'team only: margin-marker-4412';

let w: C35World;
let client: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c35pinproj');
  client = await shareWithClient(w.world.db.app, w.world.business, w.admin, w.taskA);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 the client projection of pins', () => {
  it('C35 the client projection carries a client pin and never an internal one', async () => {
    const opened = detailOf(await w.open(w.ava));
    const revisionId = String(opened['revisionId']);
    expect(codeOf(await w.capture(w.ava, revisionId))).toBe('not-a-refusal');
    const forClient = detailOf(
      await w.pin(w.ava, revisionId, {
        audience: 'client',
        body: 'Is this the photo you wanted here?',
        width: 390,
        selector: [spot('xywh=0,200,390,240')],
      }),
    );
    const internal = detailOf(
      await w.pin(w.ava, revisionId, {
        body: INTERNAL_MARKER,
        selector: [spot('xywh=40,40,80,80'), { type: 'TextQuoteSelector', exact: 'margin' }],
      }),
    );
    expect(internal['commentId']).toEqual(expect.any(String));

    const read = await executeRead(w.world.db.app, w.world.business, client.presented, {
      read: 'task.read',
      recordId: w.taskA,
    } as never);
    expect('task' in read).toBe(true);
    if (!('task' in read)) return;
    const comments = read.task.comments as readonly Readonly<Record<string, unknown>>[];
    const pin = comments.find((comment) => comment['id'] === forClient['commentId']);
    expect(pin).toMatchObject({
      body: 'Is this the photo you wanted here?',
      audience: 'client',
      anchor: { source: revisionId, width: 390, selector: [spot('xywh=0,200,390,240')] },
    });
    const text = JSON.stringify(read);
    expect(text).not.toContain(INTERNAL_MARKER);
    expect(text).not.toContain(String(internal['commentId']));
    expect(text).not.toContain('xywh=40,40,80,80');

    // The team reads both, each with its anchor.
    const team = await executeRead(w.world.db.app, w.world.business, w.ava.presented, {
      read: 'task.read',
      recordId: w.taskA,
    } as never);
    if (!('task' in team)) throw new Error('task.read refused the team');
    const anchors = (team.task.comments as readonly Readonly<Record<string, unknown>>[])
      .filter((comment) => comment['anchor'] !== undefined)
      .map((comment) => comment['audience']);
    expect(anchors.toSorted()).toStrictEqual(['client', 'internal']);
  });
});
