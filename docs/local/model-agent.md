# The model agent on the M5

The hosted sites carry side-panel chats to Ollama on the M5 through the model
agent (`apps/model-agent/`), an agent actor with its own login. It is a new
process on the M5, beside the worker. [OLLAMA.md](OLLAMA.md) covers the hosted
half.

It connects out only, to Supabase. It holds no database privilege and no
provider secret: custody, its child process, holds Ollama's credential filed
as `none`. It runs only a request the hosted API sealed for a call it
accepted, once, and only a streamed chat with an offered model. Custody writes
it to Ollama within 3 seconds of the accept on the M5's clock, or not at all
(`SEND_LAPSED`). Above a one-minute load of 45 it refuses
`MODEL_MACHINE_BUSY`. Its log names steps, never ids or chat text.

## Install

1. Make the agent actor and its login with the operator scripts, as for the
   M5 worker; the password goes in Bitwarden.
2. Write custody's credential file, mode 600:
   `[{"ref":"ollama_key","kind":"api_key","account":"m5-ollama","destination":"ollama","scheme":"none"}]`
3. Write the settings file, mode 600, with lower-case ids: `business`,
   `agent`, `gotrueUrl`, `email`, `password`, `providerKey`, `realtimeUrl`,
   `carryKey` (the hosted API's `MODEL_BROKER_CARRY_KEY`),
   `ollamaOrigin` (`http://127.0.0.1:11434`), `credentialsFile` and
   `credentialRef` (`ollama_key`). The agent refuses to start when anyone
   else can read it, or when Ollama is not on loopback.
   For paid chat (`OPENROUTER.md`), add both or neither of
   `openrouterCredentialRef` (`openrouter`) and `openrouterOrigin`
   (exactly `https://openrouter.ai`), and the OpenRouter entry in custody's
   credential file. Without them the agent refuses every paid request and
   sends nothing. For the owner's ChatGPT plan, add all or none of
   `planTokenFile`, `planOrigin` and `planIssuer`
   ([chatgpt-plan.md](chatgpt-plan.md)).
   For Hermes Agent, add both or neither of `hermesCredentialRef` (`hermes`)
   and `hermesOrigin` (exactly `http://127.0.0.1:8642`), and the Hermes entry
   in custody's credential file ([HERMES.md](HERMES.md)).
4. Run `scripts/m5/model-agent-install-check.sh <settings> <credentials>`.
5. Fill the `@…@` values in `deploy/m5/ops-astro-model-agent.plist`, copy it
   to `~/Library/LaunchAgents/` and `launchctl load` it. launchd starts it
   again if it or its custody stops.

To rotate the carry key, set the new one as `carryKeyNext` here and
`MODEL_BROKER_CARRY_KEY_NEXT` on the hosted API, restart both, then make it
the current key on both, remove the next one, and restart again.
