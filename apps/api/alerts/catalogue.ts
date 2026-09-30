// SPDX-License-Identifier: AGPL-3.0-only
//
// Every alert the installation sends, in plain words (ticket S0-2, build
// safeguards rule 3): what broke, what it affects and what happens next.
//
// The words are fixed here and only the place (staging or production) is
// filled in. An alert that interpolated a value could carry a setting, a
// secret or a record identifier; one that cannot interpolate cannot. The
// watcher's monitors are named with these titles, because its mail carries
// the monitor's name and its status view publishes it.

export type Where = 'staging' | 'production';

/** What broke, what it affects, what happens next; `{place}` is the only blank. */
const WORDS = {
  'web-down': [
    '{Place} is not loading in the browser',
    'Nobody can open the app on {place}',
    'The watcher keeps checking every minute and mails again when it is back; if it stays down, the owner restarts the web service from the runbook',
  ],
  'api-down': [
    "{Place}'s API is not answering its health check",
    'Tasks cannot be opened, created or changed on {place}',
    'The watcher keeps checking every minute and mails again when it is back; if it stays down, the owner restarts the API from the runbook',
  ],
  'sink-down': [
    'The error sink is not answering',
    'Application errors are not being recorded, so no error alerts can be sent',
    'The watcher keeps checking every minute and mails again when it is back; if it stays down, the owner restarts the error sink from the runbook',
  ],
  'backup-silent': [
    "{Place}'s backup did not check in on time",
    'The latest records may not be in a backup yet',
    'The owner checks the backup job from the runbook and runs it by hand if it failed',
  ],
  'restore-stale': [
    "{Place}'s restore drill is out of date",
    'Nobody has proved lately that the backups can be restored',
    'The owner asks the second operator to run the restore drill from the runbook',
  ],
  'app-error': [
    'The app hit an unexpected error on {place}',
    'One request did not complete, and the person who made it was asked to retry',
    'The error is kept in the error sink for the owner to review; nothing else happens on its own',
  ],
  test: [
    'Nothing broke: this is a test alert from {place}',
    'Nothing is affected',
    'No action is needed; tell the owner it arrived',
  ],
  'sign-in-failures': [
    'Repeated failed sign-ins on {place}',
    'Someone may be guessing a password or using a sign-in that no longer works',
    'Nothing is locked automatically; the owner checks the sign-in record and resets the password if needed',
  ],
  'authority-changed': [
    'A permission, grant or custody changed on {place}',
    'Who can see or change some records may be different now',
    'The owner checks the change in the audit record and reverses it if it was not expected',
  ],
  'secret-scan-failed': [
    'The secret scan failed on {place}',
    'A password or key may have been written somewhere it should not be',
    'The change is held until the owner checks it, and the key is replaced if it was real',
  ],
  'cross-scope-burst': [
    'Someone was refused access outside their permissions many times on {place}',
    'Someone may be looking for records they cannot see; nothing was shown to them',
    'The owner reviews the sign-in record and removes the sign-in if it is not expected',
  ],
  'webhook-signature-failures': [
    'Repeated incoming messages with a bad signature on {place}',
    'A connected service may be set up wrongly, or its messages faked; none were accepted',
    "The owner checks the connected service's key and replaces it if needed",
  ],
  'export-volume': [
    'Unusually many exports or downloads on {place}',
    'A large amount of client information may have been copied out',
    'Nothing is blocked automatically; the owner checks who did it and removes access if it was not expected',
  ],
  'forwarder-silent': [
    "{Place}'s forwarder did not check in on time",
    'Errors and security alerts from the app on {place} are not being sent',
    'The owner restarts the forwarder from the runbook; what the app recorded waits for it',
  ],
  'signals-dropped': [
    "{Place}'s forwarder dropped errors and security signals it did not handle in time",
    'Some errors were not recorded and some failed sign-ins, refusals or exports were not counted',
    'The owner checks that the forwarder is running, from the runbook; nothing else happens on its own',
  ],
} as const;

export type AlertKind = keyof typeof WORDS;
export const ALERT_KINDS: readonly AlertKind[] = Object.keys(WORDS) as AlertKind[];

export interface PlainAlert {
  /** What broke, alone: the watcher's monitor name and the mail's subject. */
  readonly title: string;
  readonly text: string;
}

export function plainAlert(kind: AlertKind, where: Where): PlainAlert {
  const place = (line: string): string =>
    line
      .replace('{Place}', where === 'staging' ? 'Staging' : 'Production')
      .replace('{place}', where);
  const [broke, affects, next] = (WORDS[kind] as readonly string[]).map((line) => place(line));
  return {
    title: broke ?? '',
    text: `What broke: ${broke}.\nWhat it affects: ${affects}.\nWhat happens next: ${next}.`,
  };
}
