// SPDX-License-Identifier: AGPL-3.0-only
//
// A reply may end with one task block. A second block anywhere before the
// closing one draws no card and the words show as written. A Markdown fenced
// block may open with up to three spaces of indent, and its info string's
// first word is its language, so each reply below carries two task blocks.

import { describe, expect, it } from 'vitest';
import { readProposal } from '../../packages/core-wire/src/task-proposal.ts';

const first = '{"action":"create","title":"Book the printer"}';
const last = '{"action":"create","title":"Book the venue"}';
const closing = `\`\`\`task\n${last}\n\`\`\``;

describe('a second task block', () => {
  it('a second task block opened with an indent draws no card', () => {
    const body = `Two ideas.\n\n   \`\`\`task\n${first}\n   \`\`\`\n\n${closing}`;
    expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
  });

  it('a second task block whose info string goes on past task draws no card', () => {
    const body = `Two ideas.\n\n\`\`\`task json\n${first}\n\`\`\`\n\n${closing}`;
    expect(readProposal(body)).toStrictEqual({ words: body, proposal: null });
  });
});
