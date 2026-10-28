# The side panel on Hermes Agent

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Hermes Agent is the owner's own agent on the M5 (#2270). A person on
`OPS_HERMES_PEOPLE` can pick "Hermes Agent" for a conversation in the side
panel, type, and get its reply. It is never the default, and it is never
offered on a conversation opened on a client's task.

Owner decision, 28 October 2026: Hermes Agent may act on the M5 with its own
tools, for the owner's own chats only. The side panel's other models still
run with tools off ([LOCAL-AGENT.md](LOCAL-AGENT.md)), and Ops Astro never
acts on any reply: a reply is text the server keeps. Hermes Agent reads and
changes no Ops Astro data.

## What it sends

Only the conversation's own words: its last ten turns and the typed message,
as `{ "model": "hermes-agent", "messages": [...], "stream": true }`. No
instructions, and no page or task text, which other people may have written.
The model agent refuses any other shape before custody sees it.

Hermes Agent's own model calls go to OpenAI on the owner's ChatGPT plan. That
is Hermes Agent's business on the M5; Ops Astro's call never leaves the
machine. No money moves: the call is unpriced.

## The reply

Custody on the M5 calls `http://127.0.0.1:8642/v1/chat/completions` with
Hermes Agent's key, and decodes its stream as it does OpenRouter's
([OPENROUTER.md](OPENROUTER.md), "How the answer streams"): redacted, then
folded into one answer. The panel shows "working" while it runs and the
whole reply when it is done, within the panel's 120 seconds. An error, or a
run Hermes Agent cancels or cuts short, shows as no reply. Streaming, longer
replies and one Hermes session per conversation are #2271.

## Switch it on

1. **The key.** Hermes Agent's API server key is `API_SERVER_KEY` in
   `~/.hermes/.env` on the M5. Copy it, without printing it, into the model
   agent's custody credentials file (mode 600) beside the other entries:

   ```json
   {
     "ref": "hermes",
     "kind": "api_key",
     "account": "m5-hermes",
     "destination": "hermes",
     "header": "authorization",
     "scheme": "bearer",
     "value": "<the key>"
   }
   ```

   A new key on Hermes Agent's side needs the entry again, and a restart of
   the model agent.

2. **The model agent's settings**: `hermesCredentialRef` (`hermes`) and
   `hermesOrigin` (exactly `http://127.0.0.1:8642`), both or neither
   ([model-agent.md](model-agent.md)). Restart `ops-astro-model-agent`.
3. **The hosted API's settings** (carried mode only):

   ```sh
   OPS_HERMES_PEOPLE=<businessId>:<personId>[,…]
   MODEL_BROKER_ROUTES='[…,{"key":"m5_hermes","reach":"local","provider":"hermes","credentialRef":"carried","credentialKind":"api_key","installation":"<install>","ceiling":1}]'
   ```

   The API does not start if the list is malformed, names a person
   `MODEL_BROKER_CARRIER` does not carry for, or is set without exactly one
   local API key Hermes route; if a Hermes route is set without the list; or
   if the list is set on an install that is not carried.
