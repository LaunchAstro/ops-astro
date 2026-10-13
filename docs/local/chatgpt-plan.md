# The owner's ChatGPT plan on the M5

The first agent run uses the owner's own ChatGPT plan, through Sign in with
ChatGPT on the M5 (#1620). The plan's token stays on the M5: custody there
holds it, refreshes it and presents it. It never reaches the hosted site, Git,
chat or a log. Only runs the owner started may use it.

This page holds the owner's one-time sign-in checklist, and the two real
checks that follow it: one refresh across an expiry, and one call that
settles the tool shape. The [model agent](model-agent.md) page covers the
rest of the M5 install.

## How it works

- The owner signs in once on the M5 through the loopback PKCE flow, with the
  scopes `offline_access resource.invoke chatgpt.tokens.use.direct`. The
  sign-in command writes the token file, mode 600.
- Custody's credential file names that token file. Custody refreshes the
  access token 5 minutes before it expires, when a call asks, and writes the
  rotated pair before it uses it. A refused refresh means a new sign-in:
  until then every call is refused `SUBSCRIPTION_SIGN_IN_NEEDED` and nothing
  is sent.
- The model agent sends only the pinned request to
  `https://api.openai.com/v1/responses`: the model, the instructions, the
  turns, function tools, `store: false` and `stream: true`. Custody reads
  the answer whole, folds it to the completed response and redacts it before
  anything leaves custody.
- A 429 means the plan's allowance is used up (`PLAN_ALLOWANCE_WAIT`); a 403
  is a refusal (`SUBSCRIPTION_REFUSED`). Neither is tried again.
- The broker carries the plan's route only for runs the owner started
  (`SUBSCRIPTION_NOT_OWNER_STARTED` for any other run). Every call on it is
  recorded with `credential_kind = subscription`.
- The hosted site reaches the plan's route only once the hosted handoff to
  the M5 is built (the second pull request of #1620). Until then these steps
  prepare the M5 and prove its half.

## Owner checklist: sign in once

Do these on the M5, in a terminal you are logged in to yourself. Never paste a
token, a code or the token file into chat, a ticket or a file in Git.

1. Have the client id that the plan's open-source token sharing gave Ops
   Astro. It is not a secret. If you have none, stop here and tell the
   orchestrator: nothing below works without it.
2. Choose the token file's place, outside any repository, for example
   `~/.ops-astro/chatgpt-plan.json`. Make its folder yours only:
   `mkdir -p ~/.ops-astro && chmod 700 ~/.ops-astro`.
3. From the ops-astro checkout on the M5, run:

   ```sh
   node apps/model-agent/chatgpt-sign-in-command.ts \
     --client-id <client id> \
     --token-file "$HOME/.ops-astro/chatgpt-plan.json"
   ```

4. Your browser opens the ChatGPT sign-in. Sign in with the ChatGPT account
   the plan is on and approve. The page then says you can close the tab.
5. The terminal says `Signed in.` A refusal names its reason
   (`SIGN_IN_STATE_MISMATCH`, `SIGN_IN_DECLINED`, `SIGN_IN_EXCHANGE_FAILED`,
   `SIGN_IN_TIMED_OUT`, `SIGN_IN_STORE_FAILED`); run step 3 again.
6. Check the file is yours only: `ls -l ~/.ops-astro/chatgpt-plan.json` shows
   `-rw-------`.
7. Add the plan's entry to custody's credential file (mode 600), using the
   whole path of the token file:

   ```json
   {
     "ref": "chatgpt_plan",
     "kind": "subscription",
     "account": "owner-plan",
     "destination": "chatgpt_plan",
     "scheme": "oauth_refresh",
     "tokenFile": "<whole path of the token file>",
     "refreshDestination": "chatgpt_sign_in"
   }
   ```

8. Add the three plan settings to the model agent's settings file, all
   together: `chatgptCredentialRef` (`chatgpt_plan`), `chatgptOrigin`
   (exactly `https://api.openai.com`) and `chatgptSignInOrigin` (exactly
   `https://auth.openai.com`). Restart the model agent.

## Owner checklist: the one real call (tool shape)

1. Run, with the model agent's settings file:

   ```sh
   MODEL_AGENT_SETTINGS=<settings file> node apps/model-agent/chatgpt-plan-probe.ts
   ```

2. It prints `top_level: 200 accepted`, or for a refusal of that shape a
   second line for `namespaced:`. It prints statuses only.
3. Paste only those one or two lines to the orchestrator. If `namespaced`
   was the one accepted, `CHATGPT_PLAN_TOOL_SHAPE` changes to `namespaced`
   in a follow-up pull request.

## Owner checklist: one real refresh

1. Leave the model agent running past the token's expiry (the access token
   lives about an hour), or run the probe again after it.
2. A call after expiry refreshes first. The agent's log says
   `custody: token refreshed`, and the probe still prints `200 accepted`.
3. Paste only that log line and the probe line to the orchestrator.

## Rules

- No one but the owner runs these steps, and only on the M5.
- Nothing reads or reuses another ChatGPT or Codex login on the machine.
- To switch to another ChatGPT account later, run the sign-in again with the
  same token file. No code changes.
