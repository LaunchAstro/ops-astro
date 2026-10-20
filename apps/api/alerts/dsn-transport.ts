// SPDX-License-Identifier: AGPL-3.0-only
//
// How an event reaches the error sink (`sink.ts`): to the store its DSN
// names, at an address resolved and checked for that send, and nowhere else.

import type { Transport } from './sink.ts';
// What a sink off the machine cannot be: the watcher's own rule.
import { UNREACHABLE } from '../../worker/heartbeat.ts';
import {
  familyOf,
  isDeniedAddress,
  pinnedTransport,
  systemResolver,
  type Resolver,
  type Transport as Carrier,
} from '../../../packages/core-connectors/src/index.ts';

const NOT_A_DSN =
  'OPS_ERROR_SINK_DSN is not a DSN at a public https address (https://<key>@<host>/<project>).';

/** How a send reaches the sink: the name's lookup and the pinned connection. Tests supply both. */
export interface Carriage {
  readonly resolve?: Resolver;
  readonly carry?: Carrier;
}

// A hung sink is a sink that is down: give up, the watcher reports it. The
// lookup is part of the send, so it spends the same deadline.
const SEND_MS = 10_000;
const ANSWER_BYTES = 64 * 1024;

/**
 * The sink's store endpoint, from its DSN. The key travels in the auth header
 * only, over https, to a public address, and never after a redirect; a
 * malformed or private DSN is refused by the setting's name, never echoed.
 *
 * The spelling check refuses a private DSN when it is read. What decides a
 * send is where the name resolves then: every answer must be public, and the
 * connection goes to the checked address only, so a name that resolves, or
 * rebinds, to a private address never receives the key.
 */
export function dsnTransport(dsn: string, carriage: Carriage = {}): Transport {
  const url = URL.parse(dsn);
  const project = url?.pathname.replaceAll('/', '') ?? '';
  if (
    url === null ||
    url.protocol !== 'https:' ||
    UNREACHABLE.test(url.hostname) ||
    url.username === '' ||
    !/^\d+$/u.test(project)
  ) {
    throw new Error(NOT_A_DSN);
  }
  const store = new URL(`${url.protocol}//${url.host}/api/${project}/store/`);
  const auth = `Sentry sentry_version=7, sentry_client=ops-astro/1, sentry_key=${url.username}`;
  const { resolve = systemResolver, carry = pinnedTransport() } = carriage;
  return async (event) => {
    const started = Date.now();
    const answers = await within(resolve(store.hostname), SEND_MS);
    const [address] = answers;
    if (address === undefined || answers.some((answer) => isDeniedAddress(answer))) {
      throw new Error('the error sink name is not a public address');
    }
    const answer = await carry({
      url: store,
      address,
      family: familyOf(address),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sentry-auth': auth },
      body: new TextEncoder().encode(JSON.stringify(event)),
      timeoutMs: Math.max(1, SEND_MS - (Date.now() - started)),
      maxBytes: ANSWER_BYTES,
    });
    if (answer.kind !== 'answer') throw new Error(`the error sink did not answer (${answer.kind})`);
    if (answer.status < 200 || answer.status > 299) {
      throw new Error(`the error sink answered ${answer.status}`);
    }
  };
}

/** `work`, or a refusal once `ms` have passed; the lookup's own text never surfaces. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the error sink did not answer in time')), ms);
  });
  try {
    return await Promise.race([
      work.catch(() => {
        throw new Error('the error sink name did not resolve');
      }),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
