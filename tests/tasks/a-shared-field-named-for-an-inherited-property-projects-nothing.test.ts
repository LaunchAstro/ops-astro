// SPDX-License-Identifier: AGPL-3.0-only
//
// The client projection reads a comment's values by field key from its own table, so a shared
// field whose key names an inherited Object property (`constructor`, `toString`) projects
// nothing, rather than calling that property on the whole comment (the class of S2114-1).

import { describe, expect, it } from 'vitest';
import {
  externalCommentProjection,
  type StoredComment,
} from '../../packages/core-records/src/tasks/comments.ts';
import type { FieldDefinition } from '../../packages/core-records/src/records/fields.ts';

const comment: StoredComment = {
  id: '0b6f2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b',
  taskId: '1c7e3b4f-2d5e-4f60-9b0c-1d2e3f4a5b6c',
  authorActorId: '2d8f4c50-3e6f-4071-8c1d-2e3f4a5b6c7d',
  commentType: 'client',
  audience: 'client',
  body: 'For the client',
  postedAt: new Date('2026-10-19T00:00:00Z'),
  editedAt: null,
  source: 'internal-source-marker',
  parentId: null,
  onBehalfOfPersonId: null,
  anchor: null,
  fromOutside: false,
};

const shared = (key: string): FieldDefinition => ({
  id: `field-${key}`,
  recordTypeId: 'comment-type',
  key,
  valueType: 'text',
  slot: null,
  writeMode: 'generic',
  owningOperations: [],
  owningOperation: null,
  escalatingOperation: null,
  visibilityClass: 'shared',
  searchable: false,
  uniqueValue: false,
  origin: 'preset',
  deactivatedAt: null,
});

describe('the client projection by field key', () => {
  it('a shared field named for an inherited property projects nothing', () => {
    const fields = ['body', 'constructor', 'toString', '__proto__', 'hasOwnProperty'].map((key) =>
      shared(key),
    );
    const [projected] = externalCommentProjection([comment], fields);
    expect(projected).toStrictEqual({ id: comment.id, body: 'For the client' });
    expect(JSON.stringify(projected)).not.toContain('internal-source-marker');
  });
});
