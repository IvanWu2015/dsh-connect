# Competitive analysis & what to build next

> Written 2026-10-10, against `dsh-connect` 1.0.14 (repo state `148ec10`).
> **Method and its limits.** `web_search` was unavailable (HTTP 401 on the search
> endpoint), so every external claim below comes from fetching project docs and READMEs
> with `web_fetch`. GitHub HTML pages are mostly boilerplate, so raw READMEs and the
> vendors' `.md` doc alternates were used where possible. **Claims that could not be
> fetched are marked UNVERIFIED and are not relied on.** Every claim about
> `dsh-connect` itself was checked against this repository's code, not assumed.

## 1. The landscape

Two very different groups are relevant. Vendors ship *their own* agent with a chat
surface; open-source projects ship an agent with **no** chat surface (or a programmatic
one). `dsh-connect` is in neither group: it is a **chat bridge for a runtime you already
run yourself**.

| Project | Chat control surface | Whose runtime | Open source | Differentiator |
|---|---|---|---|---|
| [OpenHands / Agent Canvas](https://raw.githubusercontent.com/OpenHands/OpenHands/main/README.md) | Slack / GitHub / Linear as **automation triggers** | Any **ACP** agent (Claude Code, Codex, Gemini, OpenCode…) | Yes | Multi-runtime behind one frontend |
| [Claude Code](https://code.claude.com/docs/en/slack.md) | **Slack** `@Claude`, web, mobile Code tab, [Remote Control](https://code.claude.com/docs/en/remote-control.md) | Anthropic's | **No** | Widest surface count; Remote Control drives a *local* session |
| [OpenAI Codex](https://raw.githubusercontent.com/openai/codex/main/README.md) | Codex Web / cloud agent; **Slack UNVERIFIED** (docs returned 403) | OpenAI's | CLI Apache-2.0 | Plan-based sign-in |
| [Aider](https://raw.githubusercontent.com/Aider-AI/aider/main/README.md) | **None** | Any LLM | Yes | Repo map, auto-commits, voice |
| [Cline](https://raw.githubusercontent.com/cline/cline/main/README.md) | **None** | Any model | Yes (JetBrains plugin closed) | Plan/Act, checkpoints, MCP |
| [OpenCode](https://opencode.ai/docs/server/) | **None** — but an HTTP API with `POST /session/:id/permissions/:permissionID` | Own | Yes | The cleanest documented substrate for a third-party bridge |
| [Devin](https://docs.devin.ai/integrations/slack.md) | **Slack** | Cognition's | **No** | Deepest chat UX: `!ask`/`mute`/`sleep`/`EXIT`, per-session "code channels" |
| [Factory](https://docs.factory.com/delegations/slack.md) | **Slack** | Factory's | **No** | Personal-vs-shared **identity** model; posts artifacts and videos back |
| [Cursor Cloud Agents](https://cursor.com/docs/integrations/slack.md) | **Slack** | Cursor's | **No** | Team + per-channel default **pools** |
| Jules (Google) | **UNVERIFIED** (fetch failed twice) | Google's | No | — |

**The single most important fact in this table:** every vendor-integrated competitor is
**Slack-only**. Nothing verified here documents Feishu/Lark, DingTalk or WeCom support.

## 2. Where `dsh-connect` stands

### Genuinely ahead

1. **Non-Western chat platforms.** Feishu/Lark (WebSocket long connection), Telegram
   (long polling) and DingTalk (STREAM over WebSocket + group-robot webhook) in one
   plugin. No verified competitor covers Feishu/Lark or DingTalk at all.
2. **Question and approval round-trips as chat buttons.** `ask_user_question` and
   permission requests render as cards answerable by **tap or numbered text**. Among the
   vendors this appears to be absent — Devin's nearest analogue is an "Apply" button on
   an env-config diff; OpenCode exposes it only at the HTTP API level. This is the
   feature that makes the bridge a *control surface* rather than a notification feed.
3. **Self-hosted and primarily chat-driven at the same time.** The closed SaaS rivals are
   chat-driven but not self-hosted; OpenHands is self-hosted but its chat surface is
   automation-oriented, not a conversational console.
4. **Chat session mirrored into the DSH Web GUI** (`/mirror`, `autoMirror`) — the same
   session object in two places, not a copy.
5. **Token-free reminders.** `/remind` and `/schedule` fire without waking the agent, so
   a scheduled reminder costs no model tokens.
6. **Context telemetry with a proactive nudge.** The task-end card reports context usage,
   and a nudge fires once per turn at `COMPACT_THRESHOLD_PCT = 75`
   (`runner.ts:1468`), offering compaction before the window fills.

### Behind, or absent

These are the real gaps, ordered by how much they'd cost us in a comparison:

| # | Gap | Who has it | Why it matters here |
|---|---|---|---|
| G1 | **No automatic artifact return.** `/send <path>` is manual | Factory posts files/artifacts/videos on completion | A long task that writes a report or a chart should hand it over without being asked |
| G2 | **No "dedicated channel per long session"** | Devin code channels; Factory opens a channel for PR work | A single ever-growing card is a worse home for a long run than its own room |
| G3 | **No per-chat run-as identity** | Factory: personal DM = your identity, shared channel = service account | Matters for audit trails in team groups |
| G4 | **No inbound webhook trigger** | Common in third-party bridges | CI/PR events should be able to start a session, not just a human message |
| G5 | **Single runtime (DSH only)** | OpenHands drives any ACP agent | A runtime seam would widen the audience |
| G6 | **No pool / scheduling-target abstraction** | Cursor's team + per-channel pools | Currently one chat binds to one workdir |
| G7 | **No "quick answer" mode** | Devin's `!ask` | Not every question deserves a full agent turn |
| G8 | **No marketplace presence** | Claude Code is in the Slack App Marketplace | Feishu app-directory listing would help discovery |

**On G6, a correction to the usual framing:** `/workspaces` already lists multiple
workdirs and `/dir` switches between them, so the *user-facing* need is partly met. What
is missing is an administrative pool concept, not the ability to change directory.

## 3. Recommended order

1. **G1 — automatic artifact return.** Highest ratio of visible value to effort: the
   transport (`sendFile`) already exists and is implemented for Feishu and Telegram
   (`/send`). What is missing is detecting *which* files a turn produced. A conservative
   version — offer the newest files written under the workdir during the turn, as a
   button — avoids guessing at intent.
2. **G4 — inbound webhook trigger.** It reuses the existing webhook server path and turns
   the bot from a chat toy into something CI can drive.
3. **G2 — channel per long session.** Larger, and it interacts with binding and locking.
   Worth doing only after the two above.
4. **G3 and G6** are organisational features; they matter for teams, not solo users, and
   should follow real demand.

G5 (multi-runtime) is a strategic decision, not a backlog item: it would change what this
project *is*.

## 4. Where `dsh-connect` should NOT compete

- **Slack-first vendors' polish.** Devin and Factory have deep command vocabularies
  (`!ask`, `mute`, `sleep`, `aside`) and richer artifact UX. Chasing parity there would
  mean abandoning the platforms that are actually uncontested.
- **Being a chat client.** The value is that your team already has one.

## 5. Honest caveats

- **UNVERIFIED and therefore not relied on:** the Codex Slack integration (403), Jules'
  chat control (fetch failed), and one third-party `claude-code-telegram` bridge whose
  feature list came from a single successful fetch that could not be repeated.
- **The comparison is asymmetric by construction.** Vendors were assessed from their
  marketing docs; `dsh-connect` was assessed from its source. A feature listed in a
  vendor's docs may be less reliable than one asserted by a test here, and a feature
  absent from a vendor's docs may still exist.
- **The lock is one-sided** (`channels/web/adapter.ts:25`): the Web GUI never sends
  inbound messages through this plugin, so it cannot respect the chat lock. The README now
  says so where the locking feature is described.
