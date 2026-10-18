# The agency site's credentials in custody on the M5

Ops Astro changes agencyastro.com through two credentials, and custody on the
M5 is their only holder (ADR 0028). Custody sends each only to its own
provider, on the catalogued site routes, and never on a `PATCH`.

| Entry            | Provider                 | Scoped to                                        |
| ---------------- | ------------------------ | ------------------------------------------------ |
| `source_control` | `https://api.github.com` | the repository `LaunchAstro/agency-astro-astro`  |
| `hosting`        | `https://api.vercel.com` | the Vercel project `agency-astro-web` (the site) |

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
