# The side panel on a paid model (OpenRouter)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

A person on the install's outside people list can pick a paid model for a
conversation in the side panel: Claude Haiku 5.5 through OpenRouter, shown as
"Claude Haiku 5.5 (paid, internal only)". It is never the default, and it is
offered only on a conversation with no client page. The answer streams word by
word, as Ollama's does.

Each reply sets aside the most it can cost from the business's AI chat budget
(Settings, "AI chat budget") before anything is sent. It keeps what OpenRouter
reports it cost, at AUD 1.60 per US dollar, rounded up to a cent, and frees the
rest. A reply whose cost cannot be known stays set aside until an owner records
what happened.

## Switch it on

1. **The key.** Bitwarden is the record. Copy the OpenRouter key into the
   custody credentials file on the machine that runs custody (the M5), mode
   600, beside the other entries. The live site never holds it:

   ```json
   {
     "ref": "openrouter",
     "kind": "api_key",
     "account": "agency-astro-openrouter",
     "destination": "openrouter",
     "header": "authorization",
     "scheme": "bearer",
     "value": "<the key>"
   }
   ```

2. **OpenRouter's own limit.** On OpenRouter, set the key's credit limit to
   US$10.
3. **The budget.** In Settings, set the AI chat budget to about AUD 15, so it
   runs out before the credit does. Only an owner or an administrator can.
4. **The settings**, beside the broker's four:

   ```sh
   OPS_OUTSIDE_PROVIDER=openrouter
   OPS_OUTSIDE_MODEL_PEOPLE=<businessId>:<personId>[,…]
   MODEL_BROKER_DESTINATIONS='[…,{"key":"openrouter","origin":"https://openrouter.ai","stream":"openai_sse"}]'
   MODEL_BROKER_ROUTES='[…,{"key":"openrouter","reach":"cloud","provider":"openrouter","credentialRef":"openrouter","credentialKind":"api_key","installation":"<install>","ceiling":1}]'
   ```

   The API does not start if:
   - the provider is anything other than `openrouter`;
   - the people list is empty or malformed, or set with the provider off;
   - there is no OpenRouter route, or the route is not a cloud API key route;
   - the destination is not exactly `https://openrouter.ai` with `stream: "openai_sse"`.

   On the hosted site (carried mode), the key stays in the model agent's
   custody on the M5, so the hosted API sets no destinations. It sets the
   provider and the people list, and adds the one OpenRouter route
   (`reach` cloud, `credentialKind` api_key) to its `MODEL_BROKER_ROUTES`.
   Every person on the people list must also be on `MODEL_BROKER_CARRIER`'s
   people, or the API does not start. The model agent's two paid settings are
   in `model-agent.md`.

5. **The register.** Record OpenRouter on the overseas-services register as an
   internal-only provider of paid chat answers, with the credit cap.

## What it sends

The request is pinned, so OpenRouter cannot charge more than the hold:

- the model picked;
- the instructions, the conversation's earlier turns and the message;
- `max_tokens` 2,048 and usage included;
- `max_price` per million tokens as declared;
- no data collection and no fallback provider.

Only the person's own typed words and their own conversation's turns go, never
a client's material, another person's words, or any task or run work.

## How the answer streams

Custody decodes OpenRouter's stream itself, because it presented the key and
an answer might echo it, split across events:

- each event is redacted as JSON;
- the decoded text passes a redactor that holds back the key's longest spelling
  until the next event;
- the broker receives decoded, redacted pieces and one folded answer, never
  the raw stream.

The first words show once they pass what custody holds back.

## What it refuses

- A message whose page has a client, or another person's turns in the history:
  nothing is sent.
- A reply past what the budget has left: refused, with what is left.
- A conversation too long for the model: refused before anything is set aside.
- A change at the moment of sending (access, session, page, client, model):
  nothing is sent and the hold is freed.
- A stream that breaks after OpenRouter accepted the request, an answer from
  another model, or no reported cost: the most stays set aside and nothing is
  kept.
