// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's client privacy card (C60, CS-7.40): each client record's
// settings as the read holds them, and the act that changes one client's,
// `client.set_privacy` under `privacy:manage`. Model use goes on only with
// the client's written request, sent in the same command; the server refuses
// a cloud provider while no local model exists and says so in its own words,
// which the screen shows unchanged.

import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Button, Card, Chip, Select, Switch, Table, TextField } from '@launchastro/ui';
import type {
  AccessReadResult,
  ClientPrivacyView,
} from '../../../../../packages/core-wire/src/index.ts';

/** The providers this screen offers; the command line and API take the whole list. */
const PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'chatgpt', label: 'ChatGPT' },
];

const OFF = { modelEgress: false, providers: [], handlesHealth: false, noAgentEdits: false };

/** The settings in words, model use first. */
function words(privacy: ClientPrivacyView): readonly string[] {
  return [
    privacy.modelEgress ? `Model use on: ${privacy.providers.join(', ')}` : 'Model use off',
    ...(privacy.handlesHealth ? ['Handles health information'] : []),
    ...(privacy.noAgentEdits ? ['No agent edits'] : []),
  ];
}

function Toggle(props: {
  readonly id: string;
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}): ReactElement {
  return (
    <div className="setrow" data-privacy-setting={props.id}>
      <div className="setrow__t">
        <h3 className="setrow__k">{props.label}</h3>
      </div>
      <div className="setrow__ctl">
        <Switch label={props.label} on={props.on} onChange={props.onChange} />
      </div>
    </div>
  );
}

/** The written request's three fields, asked only when model use is switched on. */
function RequestFields(props: {
  readonly request: Readonly<Record<string, string>>;
  readonly onChange: (field: string, value: string) => void;
}): ReactNode {
  const field = (key: string, label: string, hint?: string) => (
    <div data-field={key}>
      <TextField
        label={label}
        hint={hint}
        value={props.request[key] ?? ''}
        onChange={(value) => props.onChange(key, value)}
      />
    </div>
  );
  return (
    <>
      {field('requestedBy', 'Who asked, at the client')}
      {field('requestedOn', 'Asked on', 'YYYY-MM-DD')}
      {field('requestLink', 'Link to the written request')}
    </>
  );
}

const switchesOn = (now: ClientPrivacyView | undefined, provider: string): boolean =>
  now?.modelEgress !== true || now.providers.join() !== provider;

type Settings = Omit<ClientPrivacyView, 'clientId'>;

/** The form's state: the chosen client, its settings as edited, and the request when asked. */
function usePrivacyForm(result: AccessReadResult) {
  const [clientId, setClientId] = useState('');
  const [settings, setSettings] = useState<Settings>(OFF);
  const [provider, setProvider] = useState('claude');
  const [request, setRequest] = useState<Record<string, string>>({});
  const current = result.clientPrivacy.find((each) => each.clientId === clientId);
  const asking = settings.modelEgress && switchesOn(current, provider);
  return {
    clientId,
    settings,
    provider,
    request,
    current,
    asking,
    setProvider,
    choose: (id: string): void => {
      const chosen = result.clientPrivacy.find((each) => each.clientId === id);
      setClientId(id);
      setSettings(chosen ?? OFF);
      setProvider(chosen?.providers[0] ?? 'claude');
    },
    set: (key: keyof Settings) => (on: boolean) => setSettings({ ...settings, [key]: on }),
    setField: (field: string, value: string) => setRequest({ ...request, [field]: value }),
    body: (): Readonly<Record<string, unknown>> => ({
      clientId,
      ...settings,
      providers: settings.modelEgress ? [provider] : [],
      ...(asking ? request : {}),
    }),
  };
}

/** The settings as edited: model use with its provider and request, then the two switches. */
function Fields(props: { readonly form: ReturnType<typeof usePrivacyForm> }): ReactElement {
  const { form } = props;
  const { settings, set } = form;
  return (
    <>
      <Toggle
        id="model"
        label="Model use"
        on={settings.modelEgress}
        onChange={set('modelEgress')}
      />
      {settings.modelEgress ? (
        <div data-field="provider">
          <Select
            label="Provider"
            value={form.provider}
            onChange={form.setProvider}
            options={PROVIDERS}
          />
        </div>
      ) : null}
      {form.asking ? <RequestFields request={form.request} onChange={form.setField} /> : null}
      <Toggle
        id="health"
        label="Handles health information"
        on={settings.handlesHealth}
        onChange={set('handlesHealth')}
      />
      <Toggle
        id="edits"
        label="No agent edits"
        on={settings.noAgentEdits}
        onChange={set('noAgentEdits')}
      />
    </>
  );
}

function ChangePrivacy(props: {
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly onSet: (body: Readonly<Record<string, unknown>>, name: string) => void;
}): ReactElement {
  const form = usePrivacyForm(props.result);
  const clients = props.result.clientRecords.map((each) => ({
    value: each.clientId,
    label: each.name,
  }));
  const save = (event: FormEvent): void => {
    event.preventDefault();
    const name = clients.find((each) => each.value === form.clientId)?.label;
    if (name !== undefined) props.onSet(form.body(), name);
  };
  return (
    <form className="stack" onSubmit={save}>
      <div data-field="privacy-client">
        <Select label="Client" value={form.clientId} onChange={form.choose} options={clients} />
      </div>
      <Fields form={form} />
      <div className="btnrow">
        <Button
          type="submit"
          variant="primary"
          busy={props.busy ? 'Saving…' : undefined}
          disabled={form.current === undefined}
        >
          Save privacy settings
        </Button>
      </div>
    </form>
  );
}

const COLUMNS = [{ key: 'client', label: 'Client and settings' }];

export function ClientPrivacy(props: {
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly onSet: (body: Readonly<Record<string, unknown>>, name: string) => void;
}): ReactElement {
  const names = new Map(props.result.clientRecords.map((each) => [each.clientId, each.name]));
  const rows = props.result.clientPrivacy.map((privacy) => ({
    client: (
      <span data-client-privacy={privacy.clientId}>
        {names.get(privacy.clientId)}{' '}
        {words(privacy).map((each) => (
          <Chip key={each}>{each}</Chip>
        ))}
      </span>
    ),
  }));
  return (
    <div data-access="client-privacy">
      <Card
        title="Client privacy"
        sub="Model use, health information and agent edits, as each client's record holds them"
      >
        <div className="stack">
          <Table caption="Client privacy" columns={COLUMNS} rows={rows} />
          <ChangePrivacy result={props.result} busy={props.busy} onSet={props.onSet} />
        </div>
      </Card>
    </div>
  );
}
