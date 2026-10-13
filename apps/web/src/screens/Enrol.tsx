// SPDX-License-Identifier: AGPL-3.0-only
//
// `/enrol/#<token>` (C39-T): a team invitation's one-time link. The token is
// in the fragment, which no request carries to a server. The page takes it
// once, then clears it from the address bar and the tab's history entry
// before it draws or asks anything, and holds it in memory alone.
//
// Accepting sends the token, and nothing else, to `POST /api/enrol`. No
// password is asked for here and no one is signed in: the person's login is
// made by the service that holds the login provider's key, and a link to set
// a password follows by email. Every link that cannot be used reads alike,
// whatever the reason, so the page says nothing about which it was.

import { useState, type ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import { pathTo } from '../routes.ts';

export const ENROL_API_PATH = '/api/enrol';

type Stage = 'ready' | 'sending' | 'accepted' | 'invalid' | 'not-yet' | 'failed';

const WORDS: Readonly<Record<Exclude<Stage, 'ready' | 'sending'>, string>> = {
  accepted:
    'You have joined. Check your email for a link to set your password, then sign in. The link arrives within a few minutes.',
  invalid:
    'This invitation link cannot be used. It may have been used already, replaced by a newer one, withdrawn or expired. Ask the person who invited you to send it again.',
  'not-yet':
    'This invitation cannot be accepted yet. Ask the person who invited you; nothing has been changed.',
  failed: 'Something went wrong on our side. Nothing has been changed; try again in a minute.',
};

export interface EnrolScreenProps {
  /** The whole address, fragment included, as the tab held it on arrival. */
  readonly path: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** The tab whose address bar and history entry the token is cleared from. */
  readonly tab: Pick<Window, 'location' | 'history'>;
}

/** The token from the arrival address, the address bar cleared of it first. */
function takeToken(path: string, tab: EnrolScreenProps['tab']): string {
  const token = new URL(path, 'http://here').hash.slice(1);
  if (tab.location.hash !== '') {
    tab.history.replaceState(
      tab.history.state,
      '',
      `${tab.location.pathname}${tab.location.search}`,
    );
  }
  return token;
}

async function accept(props: EnrolScreenProps, token: string): Promise<Stage> {
  try {
    const answer = await props.fetch(`${props.apiOrigin}${ENROL_API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      redirect: 'error',
    });
    if (answer.status === 200) return 'accepted';
    if (answer.status === 401 || answer.status === 400) return 'invalid';
    if (answer.status === 409) return 'not-yet';
    return 'failed';
  } catch {
    return 'failed';
  }
}

export function EnrolScreen(props: EnrolScreenProps): ReactElement {
  // Taken once, before the first draw: the token never stays in the address.
  const [token] = useState(() => takeToken(props.path, props.tab));
  const [stage, setStage] = useState<Stage>(token === '' ? 'invalid' : 'ready');
  const onAccept = (): void => {
    setStage('sending');
    void accept(props, token).then(setStage);
  };
  return (
    <div data-screen="enrol" data-stage={stage}>
      <Card title="Join your team">
        {stage === 'ready' || stage === 'sending' ? (
          <>
            <p>You have been invited to join your team on Ops Astro.</p>
            <Button
              variant="primary"
              size="md"
              busy={stage === 'sending' ? 'Accepting…' : undefined}
              onClick={onAccept}
            >
              Accept the invitation
            </Button>
          </>
        ) : (
          <p data-outcome={stage}>{WORDS[stage]}</p>
        )}
        {stage === 'accepted' ? <a href={pathTo('agency:sign-in')}>Go to sign in</a> : null}
      </Card>
    </div>
  );
}
