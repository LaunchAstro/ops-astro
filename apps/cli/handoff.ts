// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line's honest answer to a visual operation (AW-09): the address
// of the app's page for it, printed as one JSON line, and no request.
//
// The registry is `VISUAL_HANDOFFS` (`packages/core-wire/src/handoff.ts`).
// Nothing here reads a bearer, a business or the API, because nothing is
// sent: the page asks for its own session and reads through its own commands.
// The body must hold the route's one parameter and nothing else, and the
// parameter must look like what the app puts in that segment; anything else
// is refused rather than encoded into a link that only looks right.

import {
  handoffAddress,
  VISUAL_HANDOFFS,
  type VisualHandoff,
} from '../../packages/core-wire/src/index.ts';

/** Where the app is served when neither `--web` nor `OPS_ASTRO_WEB_URL` says. */
export const DEFAULT_WEB = 'http://127.0.0.1:5190';

/** A task key or an id: letters, digits, dot, dash or underscore, at most 64. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface HandedOff {
  /** 0 with the link, 2 when the body or the origin cannot make one. */
  readonly exit: 0 | 2;
  readonly line: string;
}

function refused(name: string, fix: string): HandedOff {
  const body = { code: 'FIELD_VALUE_INVALID', names: [name], fixes: [fix] };
  return { exit: 2, line: JSON.stringify(body) };
}

/** The page's address for `handoff`, from the body and the app's origin, or the refusal. */
export function handOff(
  handoff: VisualHandoff,
  body: Readonly<Record<string, unknown>>,
  web: string,
): HandedOff {
  const extra = Object.keys(body).filter((key) => key !== handoff.param);
  if (extra.length > 0) {
    return refused(extra[0] as string, `${handoff.name} takes ${handoff.param} and nothing else.`);
  }
  const value = body[handoff.param];
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    return refused(handoff.param, `Name the ${handoff.param} as the app shows it, such as T-12.`);
  }
  let origin: URL;
  try {
    origin = new URL(web);
  } catch {
    return refused(
      'web',
      'Give the app origin as an http or https URL in --web or OPS_ASTRO_WEB_URL.',
    );
  }
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.username !== '' ||
    origin.password !== ''
  ) {
    return refused('web', 'Give the app origin alone, such as http://127.0.0.1:5190.');
  }
  const answer = {
    handoff: handoffAddress(handoff, origin.origin, value),
    operation: handoff.name,
    why: handoff.why,
  };
  return { exit: 0, line: JSON.stringify(answer) };
}

/** What `--help` adds after the operations. */
export function handoffHelp(): readonly string[] {
  return [
    '',
    'visual operations (print the app page to open; nothing is sent):',
    ...VISUAL_HANDOFFS.map((one) => `  ${one.name} --json '{"${one.param}":"<${one.param}>"}'`),
  ];
}
