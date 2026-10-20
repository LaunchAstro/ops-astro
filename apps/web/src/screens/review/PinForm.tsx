// SPDX-License-Identifier: AGPL-3.0-only
//
// A new pin on the spot marked on the revision under review (C35, #2105): its words and
// who sees it, sent as `review.pin_comment` with the spot as a media fragment on that
// width's capture. One attempt id per pin the person means, kept until that attempt is
// answered, so a retry after a lost answer pins once. The server's refusal is shown in its
// own words.

import { useRef, useState, type ReactElement } from 'react';
import { Button, FormLayout, Segmented, TextField } from '@launchastro/ui';
import { isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { xywh, type Spot } from './review-geometry.ts';

const MEDIA_FRAGMENTS = 'http://www.w3.org/TR/media-frags/';

type Audience = 'internal' | 'client';

const AUDIENCES = [
  { value: 'internal', label: 'The team only' },
  { value: 'client', label: 'The client too' },
] as const;

export interface PinFormProps {
  readonly client: OperationsClient;
  readonly revisionId: string;
  readonly width: number;
  readonly spot: Spot;
  /** Told the spot it pinned, which may no longer be the one marked. */
  readonly onPinned: (spot: Spot) => void;
  readonly onCancel: () => void;
}

/** The pin's words and audience, and its send: one attempt id per meant pin. */
function usePin(props: PinFormProps) {
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('internal');
  const { busy, because, run } = useCommand();
  // Each meant pin's attempt id, kept until that attempt is answered.
  const held = useRef(new Map<string, string>());
  const submit = (): void => {
    const words = body.trim();
    if (words === '' || busy) return;
    const command = {
      revisionId: props.revisionId,
      width: props.width,
      selector: [
        { type: 'FragmentSelector', conformsTo: MEDIA_FRAGMENTS, value: xywh(props.spot) },
      ],
      body: words,
      audience,
    };
    const intent = JSON.stringify(command);
    const { spot } = props;
    const operationId = held.current.get(intent) ?? props.client.newOperationId();
    held.current.set(intent, operationId);
    run(
      async () => {
        const answer = await props.client.mutate('review.pin_comment', command, { operationId });
        if (!isUnavailable(answer)) held.current.delete(intent);
        return answer;
      },
      (settlement) => {
        if (settlement.kind !== 'ok') return;
        setBody((now) => (now.trim() === words ? '' : now));
        props.onPinned(spot);
      },
    );
  };
  return { body, setBody, audience, setAudience, busy, because, submit };
}

export function PinForm(props: PinFormProps): ReactElement {
  const { body, setBody, audience, setAudience, busy, because, submit } = usePin(props);
  return (
    <FormLayout
      label="Pin a comment on the marked spot"
      onSubmit={submit}
      actions={
        <>
          <Button variant="primary" type="submit" {...(busy ? { busy: 'Pinning…' } : {})}>
            Pin comment
          </Button>
          <Button variant="text" onClick={props.onCancel}>
            Cancel
          </Button>
        </>
      }
    >
      <TextField
        label={`Comment on the spot at ${String(props.width)} wide`}
        multiline
        value={body}
        onChange={setBody}
        error={because ?? undefined}
      />
      <Segmented
        label="Who sees this pin"
        value={audience}
        options={AUDIENCES}
        onChange={(value) => {
          setAudience(value === 'client' ? 'client' : 'internal');
        }}
      />
    </FormLayout>
  );
}
