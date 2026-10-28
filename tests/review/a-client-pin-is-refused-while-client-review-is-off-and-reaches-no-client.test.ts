// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one proof: two pins, the client read and the team read, top to bottom */
//
// C35 (#2012), ORCH-S2158-7: client review is switched off in this cut (DECISIONS 43, the
// server's half of the web's `NO_CLIENT_GRANTS`), so a team member's pin for the client is
// refused `CLIENT_REVIEW_OFF` and writes nothing. The client reading the task shared with
// them sees no pin: neither the refused one nor an internal pin's body, anchor or id.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pin projection: DATABASE_URL is unset.');

const INTERNAL_MARKER = 'team only: margin-marker-4412';
const CLIENT_MARKER = 'for the client: photo-marker-7731';

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

describe.skipIf(serverUrl === undefined)('C35 pins while client review is off', () => {
  it('C35 a client pin is refused while client review is off and reaches no client', async () => {
    const opened = detailOf(await w.open(w.ava));
    const revisionId = String(opened['revisionId']);
    expect(codeOf(await w.capture(w.ava, revisionId))).toBe('not-a-refusal');
    const forClient = await w.pin(w.ava, revisionId, {
      audience: 'client',
      body: CLIENT_MARKER,
      width: 390,
      selector: [spot('xywh=0,200,390,240')],
    });
    expect(codeOf(forClient)).toBe('CLIENT_REVIEW_OFF');
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
    // A client reads the task shared with them, as the shared projection.
    expect('sharedTask' in read).toBe(true);
    if (!('sharedTask' in read)) return;
    const comments = read.sharedTask.comments as readonly Readonly<Record<string, unknown>>[];
    expect(comments.filter((comment) => comment['anchor'] !== undefined)).toStrictEqual([]);
    const text = JSON.stringify(read);
    expect(text).not.toContain(CLIENT_MARKER);
    expect(text).not.toContain('xywh=0,200,390,240');
    expect(text).not.toContain(INTERNAL_MARKER);
    expect(text).not.toContain(String(internal['commentId']));
    expect(text).not.toContain('xywh=40,40,80,80');

    // The team reads the internal pin alone: the refused one left no comment.
    const team = await executeRead(w.world.db.app, w.world.business, w.ava.presented, {
      read: 'task.read',
      recordId: w.taskA,
    } as never);
    if (!('task' in team)) throw new Error('task.read refused the team');
    const anchors = (team.task.comments as readonly Readonly<Record<string, unknown>>[])
      .filter((comment) => comment['anchor'] !== undefined)
      .map((comment) => comment['audience']);
    expect(anchors).toStrictEqual(['internal']);
    expect(JSON.stringify(team)).not.toContain(CLIENT_MARKER);
  });
});
