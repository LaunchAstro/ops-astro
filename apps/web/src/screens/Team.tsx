// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel (MP-7-10) on its route: the kit's one TeamPanel, fed by
// `team.list` and saving the person's own availability (CS-7.27) through
// `account/availability`. The strip is `team.list`, staff only, and a client
// is answered NOT_FOUND by the server, so this screen never decides who is
// staff. It draws nothing of its own but a refused save or send.
//
// The conversations (C71-D direct, C71-G group) are the chat reads and
// commands, live on the tab's one stream (`team/chat.ts`); a reader refused
// them gets a strip whose faces open nothing. The panel is drawn again once
// they first answer, so it opens on the first unread (R36). A teammate's name
// as the door to their work waits on a view of a person's work: plain for now.

import { useState, type ReactElement } from 'react';
import { TeamPanel, type AvailabilityChange, type Teammate } from '@launchastro/ui';
import type { TeamListResult, TeamMemberView } from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import type { StorageLike } from '../session/storage-slot.ts';
import { RecordState } from '../views/record-state.tsx';
import { describeRefusal } from '../records/submit.ts';
import { availabilitySaver } from './team/availability-saves.ts';
import { talkFor } from './team/asked.ts';
import { useChat } from './team/chat.ts';

/** A member as the panel draws them: the first name under the face. */
function teammate(member: TeamMemberView): Teammate {
  return {
    personId: member.personId,
    name: member.name,
    short: member.name.split(/\s+/u).find((word) => word !== '') ?? member.name,
    away: member.availability?.state === 'away' ? { reason: member.availability.reason } : null,
  };
}

/**
 * The reader's own availability changes, through this screen's queue
 * (`team/availability-saves.ts`): the person's last choice is the one stored.
 */
function useSetAvailability(
  client: OperationsClient,
  grantKey: string,
  say: (because: string | null) => void,
  reload: () => void,
): (change: AvailabilityChange) => void {
  const [save] = useState(availabilitySaver);
  return (change) => {
    say(null);
    save(client, grantKey, change, (result) => {
      if (isRefusal(result)) say(describeRefusal(result));
      else if (isUnavailable(result)) say(result.because);
      else reload();
    });
  };
}

export function TeamScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The whole address the screen is drawn at: the page's, or the dock panel's place. */
  readonly address?: string;
  /** Where the tab keeps unsent chat words across a reload; null keeps them in memory only. */
  readonly storage?: StorageLike | null;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<TeamListResult>({
    grantKey: props.grantKey,
    run: () => client.read<TeamListResult>('team.list', {}),
    isEmpty: (value) => value.people.length === 0,
    deps: [],
  });
  const [because, setBecause] = useState<string | null>(null);
  const chat = useChat(client, props.grantKey, setBecause);
  const onSetAvailability = useSetAvailability(client, props.grantKey, setBecause, reload);

  return (
    <div className="stack">
      <RecordState state={state} subject="team" onRetry={reload}>
        {(value) => (
          <TeamPanel
            key={chat.settled ? 'talk' : 'strip'}
            people={value.people.map(teammate)}
            me={value.you}
            onSetAvailability={onSetAvailability}
            work={null}
            conversations={talkFor(chat, value.you, props.address)}
          />
        )}
      </RecordState>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}
