// SPDX-License-Identifier: AGPL-3.0-only
//
// `restart-proof.sh --no-pull`, as the journey runs it, starts nothing when
// its pinned image is not on this machine, and says how to pull it.

import { expect, it } from 'vitest';
import { sandbox } from './restart-proof-sandbox.ts';

const ABSENT = `
case "$1" in
  inspect|image) exit 1 ;;
esac
exit 0
`;

it('restart-proof --no-pull refuses an absent image', async () => {
  const box = sandbox(ABSENT);
  try {
    const ran = await box.run(['--no-pull']);
    expect(box.docker().filter((call) => call.startsWith('run '))).toStrictEqual([]);
    expect(ran.out).toMatch(/refused: .*pull postgres@sha256:[0-9a-f]{64}/u);
    expect(ran.status).toBe(2);
  } finally {
    box.remove();
  }
}, 20_000);
