// SPDX-License-Identifier: AGPL-3.0-only
//
// restart-proof.sh holds the container it created by the id `docker run`
// returned, never by its name: a name can pass to another container while the
// run waits for readiness. The migrations go to 127.0.0.1:PORT only once this
// run's container is the one publishing it, and the trap removes only that id.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NAME, type Sandbox, sandbox } from './restart-proof-sandbox.ts';

let box: Sandbox | undefined;
afterEach(() => {
  box?.remove();
  box = undefined;
});

/** Ours answers readiness once, then is removed and NAME passes to theirs. */
const SWAPPED = `
case "$1" in
  inspect) exit 1 ;;
  image) exit 0 ;;
  run) echo cid-ours ;;
  exec)
    if [ ! -f "$STANDIN_DIR/swapped" ]; then touch "$STANDIN_DIR/swapped"; exit 0; fi
    case " $* " in *" cid-ours "*) echo 'No such container: cid-ours' >&2; exit 1 ;; esac ;;
  port)
    [ "$2" = cid-ours ] && { echo 'No such container: cid-ours' >&2; exit 1; }
    echo "127.0.0.1:$STANDIN_PORT" ;;
esac
exit 0
`;

it('a container removed and its name reused during readiness is neither migrated nor removed', async () => {
  box = sandbox(SWAPPED);
  const ran = await box.run();
  expect(existsSync(join(box.dir, 'migrated')), 'migrated the other container').toBe(false);
  const calls = box.docker();
  expect(calls.filter((call) => call.includes(' psql '))).toStrictEqual([]);
  expect(calls.filter((call) => call.startsWith('rm ') && call.includes(NAME))).toStrictEqual([]);
  expect(ran.status, ran.out).not.toBe(0);
}, 20_000);
