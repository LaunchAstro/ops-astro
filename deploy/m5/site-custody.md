# The agency site's credentials in custody on the M5

Ops Astro changes agencyastro.com through two credentials, and custody on the
M5 is their only holder (ADR 0028). Custody sends each only to its own
provider, on the catalogued site routes, and never on a `PATCH`.

| Entry            | Provider                 | Scoped to                                        |
| ---------------- | ------------------------ | ------------------------------------------------ |
| `source_control` | `https://api.github.com` | the repository `LaunchAstro/agency-astro-astro`  |
| `hosting`        | `https://api.vercel.com` | the Vercel project `agency-astro-web` (the site) |

`source_control` is moving from a fine-grained token on the owner's account
to the LaunchAstro GitHub App (#1793): see "The site source through the
GitHub App" below. The token stays until the App replaces it.

Both live in one credential file on the M5, owned by the M5's user and mode
`0600`, in a folder of mode `0700`. This runbook uses
`~/.ops-astro/custody/site.json`; the site runner (#1692) is to read the
same file. The tokens never go into Vercel settings, the database, the repository,
a log, the worker's or the runner's settings, an environment variable, a
command's arguments or a chat.

`scripts/m5/site-custody.ts` loads and checks the file. It prints entry names,
operation names and refusal codes, never a value.

## Owner: make the two tokens

1. On GitHub, signed in as the owner, make a fine-grained token for the
   repository `agency-astro-astro` only: Contents read and write, Pull
   requests read and write, 30 days.
2. On Vercel, make a token scoped to the project `agency-astro-web` only,
   30 days.
3. File each in Bitwarden as the item's password, under these names (names
   only ever go in tickets and notes):
   - `Ops Astro custody: agency site GitHub (agency-astro-astro)`
   - `Ops Astro custody: agency site Vercel (agency-astro-web project)`

If they are filed under other names, use those below and correct this page.

## Load them, once

On the M5, as its own user, in the Ops Astro checkout, with Bitwarden unlocked
in that shell. The value goes from Bitwarden straight into the load on its
standard input; it is never typed, pasted or put in an argument:

```sh
bw get password "Ops Astro custody: agency site GitHub (agency-astro-astro)" |
  node scripts/m5/site-custody.ts load --entry source_control --file ~/.ops-astro/custody/site.json
bw get password "Ops Astro custody: agency site Vercel (agency-astro-web project)" |
  node scripts/m5/site-custody.ts load --entry hosting --file ~/.ops-astro/custody/site.json
```

Each prints `site custody: <entry> loaded and read back`. The load makes the
file owner-only from its first byte, adds the entry once and reads it back.
Run again with the same token, it says `already loaded` and changes nothing.

| Refusal                    | Meaning and what to do                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ENTRY_ALREADY_LOADED`     | The entry holds another token. To replace it, follow "Rotate or revoke".                                |
| `LOAD_FILE_NOT_OWNER_ONLY` | The file is a link, someone else's, or readable by others. Remove it and load both again.               |
| `LOAD_IN_PROGRESS`         | Another load holds `site.json.lock`. If none is running, remove the lock and run again.                 |
| `CREDENTIAL_MALFORMED`     | Nothing, or not a token, came through the pipe: check Bitwarden is unlocked and the item name is exact. |
| `SESSION_TOKEN_REFUSED`    | The item holds a chat product's browser session, not an API token.                                      |
| `LOAD_NOT_READ_BACK`       | The write did not take. Check the disk and the folder's owner, then run again.                          |

## Smoke, read-only

```sh
node scripts/m5/site-custody.ts smoke --file ~/.ops-astro/custody/site.json
```

It starts custody with the file and reads, through custody alone, the About
page's source (`site.source.read` of `src/pages/about.astro` on `main`) and the
project's production deployment (`site.deployment.current`). It writes nothing
on either provider. A pass prints `site smoke: site.source.read ok` and
`site smoke: site.deployment.current ok` and exits 0. Any other line names the
operation and the code it was refused with; an expired or revoked token fails
here first.

## Rotate or revoke

Revoke first when a token may have leaked; the rest can follow.

1. Revoke the token at its provider: on GitHub, Settings, Developer settings,
   Personal access tokens, Fine-grained tokens, then the token and Revoke; on
   Vercel, the token list where it was made, then Delete.
2. Stop the site runner if it is loaded (`launchctl unload` its plist), then
   remove `~/.ops-astro/custody/site.json`.
3. To rotate, make the new token as above and file it in Bitwarden under the
   same name, replacing the old value. Load both entries again and run the
   smoke. To retire the site's access, delete or archive both Bitwarden items
   instead.

Both tokens last 30 days; rotate before then.

## The site source through the GitHub App

The LaunchAstro GitHub App replaces per-site tokens for site source. It is
installed on each site's repository. Custody on the M5 holds only the App's
private key and, for each party, the one repository it may reach. For every
call it mints a token for that one repository (`repositories` on the token
request), with Contents and Pull requests and nothing else, sends the call
with it and drops it: no token is kept, written down or logged. A call for a
party that names any other repository is refused
`CUSTODY_REPOSITORY_NOT_BOUND` before anything leaves custody. GitHub reads a
repository's name in any case, and so does custody. The token request spends
the call's own time, and a token that expires before the call goes is
refused, never sent. No part of it belongs to a person's account.

### Owner: make and install the App, once

1. On GitHub, in the LaunchAstro organisation's settings, Developer settings,
   GitHub Apps, make a new App: no webhook, no callback, installable on any
   account, so a client's own organisation can install it. Repository
   permissions: Contents read and write, Pull requests read and write,
   nothing else (Metadata read comes with them). Another account installing
   it reaches nothing: custody mints only under an installation id bound to
   a party.
2. Note its App ID. Generate a private key; GitHub downloads a `.pem` file.
3. File the key in Bitwarden as a secure note holding the whole `.pem` text,
   under `Ops Astro custody: LaunchAstro GitHub App private key`, and the App
   ID in the same item. Delete the downloaded file.
4. Install the App on the organisation, choosing "Only select repositories"
   and `agency-astro-astro` alone. The installation's page address ends in
   its installation id (`.../installations/<id>`); note it.

A client site whose repository is in the client's own organisation needs the
App installed there, with its own installation id. The client installs it from
the App's public page (`https://github.com/apps/<app name>`), choosing "Only
select repositories" and the site's repository alone.

### Load the key, once

On the M5, as above, with Bitwarden unlocked in that shell:

```sh
bw get notes "Ops Astro custody: LaunchAstro GitHub App private key" |
  node scripts/m5/site-custody.ts load-app --app-id <App ID> --file ~/.ops-astro/custody/site.json
```

It prints `site custody: source_control loaded and read back`. The key goes
in as the `source_control` entry with no repository bound yet.

### Bind a site's repository

Each site is its party's repository, bound once, under the installation that
covers it. The party id is the site's party in Ops Astro (`party_sites`).

```sh
node scripts/m5/site-custody.ts bind --party <party id> \
  --repository LaunchAstro/agency-astro-astro --installation <installation id> \
  --file ~/.ops-astro/custody/site.json
```

It prints `site custody: <repository> bound and read back`, or `already
bound`. Then run the smoke with that party; it reads the About page from that
party's bound repository:

```sh
node scripts/m5/site-custody.ts smoke --file ~/.ops-astro/custody/site.json --party <party id>
```

Adding a client site is installing the App on its repository and binding it
to the client's party. A party reaches one repository, and a repository
belongs to one party.

| Refusal                        | Meaning and what to do                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `APP_NOT_LOADED`               | `source_control` is not the App yet. Load the key first.                                   |
| `PARTY_ALREADY_BOUND`          | That party has another repository. A move is "Revoke", then load and bind again.           |
| `REPOSITORY_ALREADY_BOUND`     | Another party has that repository. Check the party id.                                     |
| `CREDENTIAL_MALFORMED`         | The key is not an RSA private key, or the App ID, repository or installation is malformed. |
| `CUSTODY_REPOSITORY_NOT_BOUND` | The smoke named no party, or one with no binding.                                          |
| `CUSTODY_TOKEN_NOT_MINTED`     | GitHub gave no token for that repository alone, in time: check the App is installed on it. |
| `CUSTODY_TOKEN_EXPIRED`        | The minted token expired before the call went. Run it again.                               |

### Move the agency site off its token

1. Load the hosting token and the App into a fresh file: move the old
   `site.json` aside, run the `hosting` load above, then "Load the key" and
   "Bind a site's repository" for the agency's party.
2. Run the smoke with the agency's party. It must pass.
3. Remove the old file. Revoke the fine-grained token on GitHub (Settings,
   Developer settings, Personal access tokens, Fine-grained tokens, the
   token, Revoke) and archive its Bitwarden item,
   `Ops Astro custody: agency site GitHub (agency-astro-astro)`.

### Rotate the App key

1. In the App's settings on GitHub, generate a new private key. The old one
   still works until it is deleted.
2. Replace the Bitwarden note's text with the new key.
3. Move `site.json` aside, load `hosting`, the App key and each binding again,
   and run the smoke for each party.
4. Delete the old key in the App's settings, then remove the old file.

### Revoke

- **One site:** in the App's installation settings, remove its repository
  (or uninstall the App from the client's organisation). Custody's next mint
  for it is refused at once. To drop the binding too, reload the file
  without it.
- **Everything:** delete the App's private keys in its settings (or suspend
  the installation). Every mint is refused from then on. Stop the site runner
  if it is loaded, remove `site.json`, and archive the Bitwarden item.

Minted tokens last at most an hour and custody keeps none, so nothing is left
to revoke after either.
