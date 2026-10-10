# Changelog

All notable changes to this project are documented following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.15] - 2026-10-10

Two fixes and a documentation pass. One of the fixes was mine to begin with.

### Fixed

- **A question card was re-sent every five seconds while it went unanswered.** The previous release stopped an unresponsive card from holding a flow open by racing it against a five-second wait for a typed reply — but the card was presented *inside* that wait's loop, so each elapsed window presented it again. The user saw the same 「需要你的选择（问题 1/2）」 card arrive over and over. The card is now presented once and that promise is kept across iterations, so the wait may time out and re-check for a typed answer as often as it likes while the card on screen stays put. The adapter's genuine expiry path still re-presents, unchanged.
- **A progress reminder could be dropped without a word.** The watchdog edited the streaming card through the turn's chunk queue, and when the turn state was gone it returned silently — no card edit, no message, no log. `disposeAgent` clears that state mid-turn (a `/new`, `/clear` or chat switch) without stopping the watchdog, which lives in `driveAgent`'s `finally` and has not run yet. A progress report whose only job is to say "still working" now falls back to posting its own message, with an elapsed time kept on the runner rather than only on the discarded turn.

### Documentation

- **The READMEs now open with why the plugin exists**, not just what it does. The Web GUI is not replaced by this; what it cannot do is reach you. The new section covers starting work from any device, watching a long turn or deliberately not watching it, answering the agent where the question appears, and the two properties that make it usable — it drives the real session rather than a copy, and the quiet levels are genuinely quiet, which tests assert.
- **Screenshots moved to the top, with the gap stated.** All 14 are of the settings pane and none of the chat itself. Rather than present a settings pane as the product, the README says plainly that a chat screenshot does not exist yet.
- **The `/help` output was half-translated.** Eight command lines were hardcoded English inside `helpText`, so a Chinese user got a mixed-language command list in the one place they go to discover what exists. All eight are now in the i18n tables, both languages.
- **The one-sided lock is now stated where users meet it.** `channels/web/adapter.ts` claimed this was "documented in README" and it was not: the Web GUI reads the mirrored session straight from DSH's session store and never sends inbound messages through this plugin, so it cannot respect the chat lock. Running one session from two writers is possible, not prevented.
- **[docs/COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md)** (and [.zh.md](docs/COMPETITIVE_ANALYSIS.zh.md)): the landscape, where this plugin stands, and what to build next. Every vendor-integrated competitor verified is Slack-only; none documents Feishu/Lark or DingTalk. Claims that could not be fetched are marked UNVERIFIED and are not relied on.
- Corrected stale reference docs: per-channel field counts now come from the live schema (the core was documented as 12 fields and has 22), `allowUsers` is described as the per-channel fallback it became, and the compatibility table's "last verified" date reflects what was actually verified.

### Notes

- **The card-spam regression was caught by a test proven to fail first**: reverting the fix makes it report "presented 3 times" in 12 seconds — the reported symptom exactly. That test also re-asserts the typed-reply escape route, so the earlier freeze fix cannot be undone to fix this one.
- The watchdog's no-turn fallback has **no test**. The state could not be constructed through the harness: clearing the runner's turn is undone by the drain loop re-entering `runTurn`, and the harness records a stream only once the turn has ended. The branch was verified by driving its exact body instead. A test that cannot pass is worse than a recorded gap.

### Testing

- **624 tests, 30 suites, all green** (was 623), plus SMOKE OK and E2E OK — both legs, including the live round trip against a real `dsh` host.

## [1.0.14] - 2026-10-09

The freeze, reported a second time and this time precisely: 「还是容易卡住，我现在一个对话，卡在第一个问题，一直不动」「怎么选，都不会变」. I had already looked at this area twice and found nothing, because I was reading the tap path. The fault was not in the tap path at all — it was in the loop that waits for it, and it is reproducible in one line.

### Fixed

- **A question whose card never resolves held the interaction open forever, and a typed reply could not break it.** `askOne` awaited `promptChoice` and *nothing else*. So when a card came back with no tap — unresponsive buttons, a lost action, an adapter that never calls back — the loop sat inside that single `await` with no timeout and no alternative, and the question never advanced. Worse, the escape route that exists for exactly this case did not work: `answerText` (any ordinary chat message) recorded the answer into `answers`, but the only thing that ever looked at `answers` was `askByText`, the *option-free* path. A question **with** options therefore had no way out: the tap did nothing and the text answer was accepted into a variable nobody read. The card and the text path are two ways to answer one question, and they now race (5 s), so whichever the user uses wins.
- **An unusable tap looped in total silence.** A choice that matched no option was dropped with a bare `continue`: the card redrew identically, nothing was logged, nothing was said. From the user's side that is indistinguishable from a freeze, and it left nothing to diagnose. It is now logged, and the user gets one notice per question explaining that the tap did not register and that replying with the number or the text also works.
- **A tap for an earlier question was discarded.** The card is reused across questions, so a tap can land after the card has moved on — the user aims at what they can still see. That is a real answer, and it is now recorded rather than dropped. The distinction matters: a stale tap for a *still-unanswered* question is recorded and the loop keeps waiting for the one on screen, whereas returning failure there would turn a late answer into a lost interaction.
- **A text reply that could not be used as an answer was swallowed.** The service consumed any non-command message while a question was pending and returned unconditionally, even when `answerText` declined. The message vanished: no answer recorded, no reply, no route to the agent. It now falls through to the normal path when the text is not usable.

### Notes

- **Why the earlier investigations missed it.** Both previous rounds examined the *tap*: whether `cardAction` fires, whether the option id round-trips, whether `updateCard` lands. All of that was correct — which is why the reports kept coming back. The defect was one level up, in a loop that only ever listened to one of its two inputs.
- **Reproduced before it was fixed**, with the real `InteractionBridge` over an adapter whose `promptChoice` never resolves: `answerText` returned `true`, `pendingFor` stayed `true`, and the flow never completed. After the race, the same script shows `pending for: false` and a completed answer.

### Testing

- **623 tests, 30 suites, all green** (was 620), plus SMOKE OK and E2E OK. The regression test for the freeze — `a text reply unblocks a question whose card never resolves` — was verified to *hang* the suite against the pre-fix code rather than merely fail, which is what the bug did in production.

## [1.0.13] - 2026-10-09

Two defects visible in one screenshot of a two-question card, both from the round-1.0.12 work on the same card.

### Fixed

- **A question's options rendered as their own truncated prefixes.** Every choice card was a fixed 2-column button grid. That is right for a menu (`状态`/`任务`) and wrong for a *question*, whose options are whole sentences: a 44-unit label does not fit a half-width button, so the renderer wrapped and elided it and the user was asked to choose between sentences they could not read. The reported card showed each option as its own cut-off copy, which reads as duplicated text rather than as one label that was truncated. Rows are now one column wide whenever any label is too wide for a half-width button, decided per set so a card never mixes row widths.
- **「⚠️ 此操作已失效」 arrived *after* 「✅ 已收到你的回答」.** `closeMenu` replaced the card with a summary but left no tap absorber. A tap still in flight — or one landing while the closing redraw was in flight — therefore found neither a pending choice nor an absorption window and fell through to the "genuinely stale" branch, telling the user their action had failed when it had in fact succeeded. `closeMenu` now retires the live listener and installs the absorber **before** the redraw, the same ordering `promptChoice` already uses for its own card updates and for the same reason.

### Notes

- **The absorption window is 5 s, and the bridge does work between the tap and the close** (it sends the acknowledgement). So the window can lapse before `closeMenu` runs, which is why this was reachable on a slow turn and not on a fast one.
- **The option text itself was never wrong.** Our code sent each label exactly once; the duplication in the report was the renderer eliding an over-long button label. The fix is the layout, not the string.

### Testing

- **620 tests, 30 suites, all green** (was 616), plus SMOKE OK and E2E OK. Both fixes were verified to go red against the code they guard:
  - Three `buildButtonGrid` tests: long labels take a full-width row, short labels keep the grid, and an explicit `1` column is honoured regardless of width (the heuristic must not override a caller that asked for one).
  - One closeMenu test, which **had to be rewritten before it meant anything**. Its first version passed against the unfixed code, because the tap that answers a prompt starts a 5 s absorption window all by itself — so the card was already absorbing and `closeMenu`'s missing absorber could not be observed. It now clears that window first, reproducing the lapse that makes the bug reachable; only then does it fail without the fix.

## [1.0.12] - 2026-10-09

A report about the interactive question cards: 「交互部分没处理好… 2，（问题 1/2）到第二个问题的时候，问题序号没更新 2。到最后个选项选择完后，应该关闭交互的选择按钮，要不然用户以为还没关闭。」

Two claims, and they did not turn out to be equally well founded. One is fixed and pinned; the other I could not reproduce, and saying so is more useful than pretending otherwise.

### Fixed

- **The question card kept its live buttons after the last answer.** Every question had been answered, but nothing replaced the card — so the options stayed on screen and the user reasonably concluded the interaction was still open. Worse, a tap on those buttons was **silently absorbed** (the adapter deliberately swallows taps on a retired card so a rapid second tap is not reported as "this action has expired"), so pressing one did nothing at all, with no feedback. The card is now replaced with a 「✅ 已提交你的选择」 summary that recaps each question and the answer given — which is also the moment the user is most likely to want to check what they sent. An approval card already did this; a question card did not.

### Not reproduced

- **The step number not advancing to the second question.** I could not reproduce this, and I will not claim a fix I cannot demonstrate. The bridge builds each question's card from the interaction's current index at the moment of presentation, and three tests now pin that: two button-answered questions give 1/2 then 2/2; a **text**-answered first question followed by a button question still gives 2/2 (the mixed path, the one a shared counter would most plausibly get wrong); and a card that expires and is re-presented keeps the right number. All three pass against the pre-existing code.
  - What I did change is defensive: the option card now **rebuilds its text on every presentation** instead of hoisting it out of the retry loop. With the current design the counter cannot advance *within* one question, so this is observationally identical today — it removes a trap rather than fixing an observed fault, and the test comment says so rather than implying more.
  - **If a stale number still appears, a screenshot of the card would settle it**: whether the header still reads 1/2, whether the *options* belong to the first or the second question, and whether the card tapped was the original or one re-presented after the ~60 s expiry. Those three facts separate "the counter never advanced" from "the card was not redrawn" from "the tap went to a card that had already been replaced", and they lead to different fixes.

### Notes

- **A question with no options still gets no card**, and therefore nothing to close — the acknowledgement message is the whole response, and that path is unchanged.
- **The closed card carries a summary, not a bare "done"**, because the answer text is otherwise gone the moment the card is replaced and the user has no way to confirm what was submitted.

### Testing

- **616 tests, 30 suites, all green** (was 611), plus SMOKE OK and E2E OK. Four new interaction tests, two of which were verified to go red against the unfixed code:
  - **the last answer replaces the card with a done state** and **a single-question card is closed too** both failed before the fix and pass after. The single-question case is covered separately because it is the common one and must not be a special case that keeps its buttons.
  - Two numbering tests pin the current behaviour. They pass either way, and their comments say they pin an observable contract rather than the implementation — a test that cannot fail should not be dressed up as one that can.

## [1.0.11] - 2026-10-09

Two more items from the pane review: 「1。设置中appid不需要先隐藏又在下面进行显示，直接显示就行，key也一样，显示部分就可以了，写明用户设置时会清除原有值就行。 2。访问控制 这里的账号设置有用吗，如果是针对相应渠道，那么也应该在渠道中，因为不同的渠道账号应该不同」

The second question had a real answer, and the user's instinct was right.

### Fixed

- **A credential was displayed twice, in two different places.** Each secret field rendered a *blank* input with a 「已配置」 placeholder plus a separate 「当前值：…」 line underneath — the same fact stated twice, in the one place where the user is trying to compare a value against the vendor console. The value is now shown **once**:
  - an **identifier** (`appId`, `clientId`) is seeded straight into its field, so it is visible and editable in the box itself;
  - a **confidential key** keeps an empty field, with the masked value in the placeholder and named in the hint (`当前值（已脱敏）：a1b2…z9y8`), because the host only ever returns a *mask* and seeding it would let a save write that mask back as the credential, destroying it silently;
  - every secret field now says so in words: 「重新填写会覆盖已保存的值；留空则不修改。」 — the part that an empty box previously only implied.
- **Access control was global, so it could only ever be right for one channel.** `allowUsers`/`allowChats` were enforced across every channel at once; the old code literally discarded the channel argument (`void channel; // allowlists are global`). That cannot work: a Feishu `ou_…` open id is meaningless to Telegram, whose user ids are numeric. One list is therefore wrong for every enabled channel but one — either it locks everyone out of the others, or (with both id sets pasted in) it matches nobody and enforces nothing. **Each channel now carries its own `allowUsers`/`allowChats`**, editable on its own card exactly as the user suggested, with the top-level lists kept as the fallback for a channel that sets none.

### Notes

- **A channel that declares an empty list means "unrestricted"**, which is deliberately distinct from omitting the key (fall back to the global list). A channel can therefore opt out of a restrictive default without disturbing the others; N2 pins that distinction.
- **The migration needs nothing from the user.** The top-level keys keep working as the fallback, so an existing profile behaves exactly as before until a per-channel list is set.
- **`channelAccess` is derived from each channel's own config block** rather than kept as a second table, so the pane and the enforcement path cannot disagree about where a list lives.

### Testing

- **611 tests, 30 suites, all green** (was 608), plus SMOKE OK and E2E OK. Each new behaviour was verified to go red against the code it guards:
  - **N1–N3** cover the per-channel gate: a channel's own list overrides the global one, an explicitly empty list means "everyone", and `allowChats` still reduces a thread-scoped key to its base chat id. Reverting the gate to global-only turns all three red.
  - **`the confidential key's input is empty, and the identifier's is seeded`** states both halves positively, so a change that quietly stops showing the identifier fails rather than passing as "still not leaking".
  - Three older assertions had to be corrected because they encoded the *old* contract, and one was **wrong in a way that would have hidden a real leak**: the "no secret in an input" check compared `APP_SECRET.slice(0, 8)`, which is `a1b2c3d4` — also the prefix of the appId fixture `cli_a1b2c3d4…`. It now compares the secret's unique tail. Another used `text.includes(s)` on an *array* of text nodes, which tests element identity rather than substring presence.

## [1.0.10] - 2026-10-09

Two follow-ups from the same report: 「现在虽然没有原来的流式实时输出，但还是有输出这种工具调用，这也没必要，一并去除。另外就是我设置了5分钟提醒进度，每隔5分钟是否会输出当前的简单状态。」

The first was a genuine miss in 1.0.6–1.0.9: every gate was written as `!== "result"` or `=== "result"`, and the tool-call line was still gated on `=== 'result'` alone — so `important` kept narrating `🔧 调用工具 pwsh` even after three rounds of "remove the live status". The second turned out to be the more interesting question, because the answer was *no*, and the reason was a design mistake of the same family.

### Fixed

- **`important` still streamed a line per tool call.** The gate read `if (this.notifyLevel === 'result') return;`, so only the default level suppressed tool activity. It is now `showsLiveStatus(…)`, which admits `full` alone — the single predicate every other gate already uses, so this class of miss has one place left to happen instead of one per call site. The now-unreachable `notifyLevel === 'full' ? summary : undefined` ternary below it was removed rather than left as a second, silently diverging copy of the same decision.
- **The 5-minute progress reminder never fired at a quiet level.** This is the one worth reading. The reminder was gated together with the liveness heartbeat on `showsLiveStatus`, on the reasoning that both "write progress chatter into the card". That reasoning is wrong: the heartbeat is *liveness chatter* — a line every 60s saying nothing but "still here", which the quiet levels exist to suppress — while the reminder is **a status report the user explicitly configured** via `progressTimeoutMs`, fires once per interval, and carries the elapsed time and the latest milestone. Gating it on the notification level meant that choosing a quieter level **silently discarded a setting the user had made on purpose**, which is why the answer to 「每隔5分钟是否会输出」 was no. The reminder now runs at every level; the heartbeat remains gated.

### Notes

- **The reminder no longer names the tool it last saw.** Its milestone was the tool name (`🔧 调用工具 pwsh`), which is precisely the activity detail the quiet levels suppress — so keeping the reminder at those levels would have smuggled the removed line back in through the one message the user kept. The milestone is now a tool-free step count (`🔧 已完成 12 步操作`), which conveys "work is still happening" without re-listing tools. The single exception is `ask_user_question`, which is not activity but a *request aimed at the user*, and hiding it would conceal the fact that the bot is waiting on them.
- **`turn.milestone` is still updated before the early return**, so suppressing the tool *line* does not cost `/status` the state that makes it useful.
- **The reminder edits the streaming card in place**, so a 5-minute tick does not add a bubble to the chat.

### Testing

- **607 tests, 30 suites, all green**, plus SMOKE OK and E2E OK. Both behaviours were verified to go red against the code they guard:
  - **K8** (tool lines) was passing *vacuously* at first — the harness emitted no `tool/call` events, so there was nothing to suppress and the test could not fail. It now scripts `toolCalls: ["pwsh", "edit"]`, and only then does reverting the gate turn it red.
  - **K4** was inverted from "the reminder stays silent at `result`" to "the reminder still fires at a quiet level, and the heartbeat does not", which is the corrected contract.

## [1.0.9] - 2026-10-08

A feature request in two parts: 「现在有没有上下文自动压缩功能，如果没有，你在设置中增加一个上下文自动压缩，打开后，到达80%长度时自动压缩。还有，每轮任务的结束，需要写清楚上下文的使用百分比。」

There was no automatic compaction. A **manual** `/compact` and a **suggestion** that prompts at 75% both existed, and neither is what was asked for: the prompt still requires the user to be watching and to answer, which is exactly what does not happen on a long unattended run.

### Added

- **`autoCompact` — compact the session automatically at the end of a turn.** Off by default, because compaction rewrites the conversation history and that is not something to switch on behind the user's back. It runs at turn end rather than mid-turn for two reasons: compaction needs an idle agent, and the threshold is about what the *next* turn has to carry — the turn that fills the window still finishes with its full history.
- **`autoCompactThresholdPct` — the trigger, default 80.** Clamped to 1–99 on resolve so a nonsense value cannot mean "compact on every turn" (0) or "never, even when the window is full" (100+).
- **Both are editable in 通用设置**, under a new **上下文** group (the pane now renders five groups), carrying the same restart notice every other general row has. Each is also overridable per chat through the new `/autocompact` command: `/autocompact on`, `/autocompact off`, `/autocompact 85`, or a bare `/autocompact` to report the current state. A bare invocation reports rather than toggles, because a typo silently disabling a safety behaviour is the wrong default for a switch like this.
- **The turn-end card names the active compaction rule.** With auto-compaction on it reads 「🤖 自动压缩已开启（达到 80% 时自动执行）」; once the threshold is passed, 「🤖 已达自动压缩阈值 80%」. Telling a user who enabled auto-compaction to send `/compact` by hand would be wrong, so the two lines are mutually exclusive rather than stacked.

### Fixed

- **The context-usage row was silently absent when the window size was unknown.** The old guard required *both* `contextSize` and `contextWindow`, so a host reporting only token counts produced a stats card with no context line at all — and a missing field reads as "nothing to worry about", the opposite of what a usage report is for. It now falls back to the token count with an explicit 「窗口大小未知」.

### Notes

- **Auto-compaction is deliberately silent on success.** It is maintenance the user asked to happen on its own, so it posts nothing; the turn-end card reports the resulting usage either way, which is where the effect is legible. A *failure* is still reported, because silently not compacting would leave the user believing they are protected.
- **The manual and automatic paths share one service lookup** (`runCompaction`), so they cannot disagree about whether compaction is available — previously that lookup was inlined in the manual path alone.
- **The threshold is a percentage of the reported window** — the same number the stats card shows, so the two always agree.

### Testing

- **607 tests, 30 suites, all green** (was 601 in 30), plus SMOKE OK and E2E OK. Six new tests in group M, and both directions of the switch were verified to go red against the code they guard:
  - **M1** fires at 85% against an 80% threshold; **M2** proves nothing runs while the switch is off even at 95% (and waits for the turn to finish first, so it cannot pass merely by running before the code under test); **M3** proves 40% does not trip an 80% threshold.
  - **M4** proves a per-chat binding overrides the plugin config.
  - **M5** asserts every turn-end card carries the real percentage; **M6** asserts an armed chat is *not* told to send `/compact` by hand.
  - The existing guards fired as designed while building this: `settings-model`, `settings-namespace` and `web-settings-roundtrip` each failed by name until the two new keys were added to the field table, the section projection and the round-trip fixture — which is what those tests exist for, since a general key missing from any of the three is silently *erased* on the user's next save.

## [1.0.8] - 2026-10-08

The report 「还是不对，已经是1.0.7了，但还是在流式实时回复当前的工作状态。这不符合我的设置。」 — and 1.0.7 *was* correctly installed in both profiles. The setting was 输出重要节点 (`important`), not 只输出结果, and `important` had never been gated at all. 1.0.6 and 1.0.7 checked `!== "result"` at every gate, which fixed the level named in the first report and left the other quiet level just as noisy.

### Fixed

- **`important` received the liveness heartbeat and the progress watchdog, so 输出重要节点 produced a running commentary.** Both timers were gated on `!== "result"`. The level is documented as 「只推送关键节点：思考开始、工具调用、最终回答」 — three *discrete* events — and a 「⏳ 仍在处理中（已运行约 N 分钟）」 line arriving every minute is not one of them. The two timers are now gated on a single `showsLiveStatus(level)` predicate that admits `full` alone, so the definition of "this level tolerates repeating status chatter" lives in one place instead of as a negated check copied onto each timer — which is precisely how one quiet level was fixed while the other stayed broken.
- **`important` streamed the answer token by token into the live card.** The answer is a milestone at this level (「最终回答」), not a stream, and the check that held it back at `result` was written as `level === "result"` rather than "any quiet level". The text is still accumulated into `lastText`, so it is delivered whole on the turn-end card exactly as at `result`. The whole-block fallback for short answers obeys the same rule.

### Notes

- **`full` is unchanged**: reasoning, tool calls, heartbeats, progress reminders and the answer all stream live, which is what 尽量输出过程 promises.
- **`important` now means what it says**: the thinking-start hint (once), a line per distinct tool, and the finished answer. Nothing repeats on a timer.
- **The 1.0.6 and 1.0.7 fixes were not wrong, only incomplete** — they covered `result`, the default and the level named in the first report. `important` is what a user picks when they want *some* visibility, which is exactly why a per-minute heartbeat there is more surprising rather than less.

### Testing

- **601 tests, 30 suites, all green** (was 598 in 30), plus SMOKE OK and E2E OK. Each new test was verified to go red against the code it is meant to catch:
  - The `unit.test.mjs` case for `important` previously asserted `["🤔 深度思考中…\n\n", "answer"]` — the test *encoded* the bug, so it had to be corrected before it could catch anything. It now asserts the hint alone, plus that `lastText` still holds the answer for the turn-end card.
  - **`showsLiveStatus`** is pinned directly: `true` for `full` alone.
  - **K8** runs a 100ms heartbeat and a 400ms watchdog on a chat set to `important` and asserts neither 「Still processing」 nor 「Still working on the task」 reaches the card *or* the chat, while the answer still arrives. This is the reported symptom stated as an assertion.

## [1.0.7] - 2026-10-08

A report that progress notices stopped after roughly 20 minutes on a long task: 「正在处理中，但到20分钟后就不报了，是你之前的修改生效了，还是原因有bug」. Investigated against the live session transcript rather than by reading code, and the answer is **neither of those two** — it was a third thing, plus a genuinely fabricated field that made the whole picture harder to read than it should have been.

### Fixed

- **`/status` reported 「上次任务：✅ 完成」 with the *current* wall-clock time as the completion time.** `getLastTurnInfo` located the real `turn/end` event, read its reason, and then stamped it with `new Date()` — the moment the user asked — instead of `event.time`. The field was therefore always "a few seconds ago", including for a turn that had never finished at all. This is the worst kind of wrong: not a missing value but a plausible fabricated one, and it is what made a 25-minute in-flight task look like a completed one. It now formats the event's own timestamp, and falls back to `—` (rather than inventing an hour) for an event shape that lacks one.
- **`/status` claimed 「🔄 正在处理任务」 for a task that nothing was driving.** `agent.status === "running"` is not proof that this process owns a turn: after a host restart the resumed session still holds a turn that was cut off mid-flight — no `turn/end` was ever written — so the agent reads "running" indefinitely while no `driveAgent` call exists and no progress notice can ever be produced. That pairing is what makes a dead task indistinguishable from a live one. `/status` now reports a distinct 「⚠️ 上次任务已中断（宿主重启或进程退出），没有任务在运行」 when the agent is busy but this process is neither draining the queue nor holding turn state.

### Notes

- **The notices stopping at ~20 minutes was not a bug in the notice logic.** The watchdog was working as designed. The session transcript for the reported chat shows the turn starting at 19:16:52 and holding until 19:41:28, and `progressTimeoutMs: 300_000` puts the ticks at +5/+10/+15/+20/+25 min — 19:21:52 / 19:26:52 / 19:31:52 / 19:36:52 / 19:41:52. The user received the notices through the +20 min tick; the host was restarted between 19:41:28 (the last event ever recorded) and 19:44, so the +25 min tick never had a process to fire in. The transcript ends mid-`tool/call` with no matching `tool/result`, which is the signature of a process that exited while the turn was still open, not of a timer that stopped.
- **The 1.0.6 level gating is unrelated and is confirmed working.** Both the heartbeat and the watchdog remain gated on `notifyLevel`; the notices above arrived on a chat set to a level that permits them.

### Testing

- **598 tests, 30 suites, all green** (was 596 in 30), plus SMOKE OK and E2E OK. Two new tests, both verified to go red against the code they are meant to catch:
  - **K6** scripts a `turn/end` stamped two hours in the past and asserts `/status` reports *that* time. The first version of this test passed even against the buggy code, because the harness emitted the event at the current instant and "now" was indistinguishable from the real answer — a test that cannot fail. It needed a new `turnEndedAtMs` harness option before it meant anything, which is the whole reason that option exists.
  - **K7** puts the agent in the post-restart state (busy, with no turn state this process owns) and asserts `/status` says the previous task was interrupted rather than claiming to be processing.

## [1.0.6] - 2026-10-08

A bug report about the notification levels: 「我已经在设置中选择了只通知结果、或重要节点，但是我发完信息后，还是不断的流式生成当前处理的详细内容，并没有按我的要求进行。另外，最后有一个整体的结果进行单独的回复，但又没有输出完整的内容，只输出了一部分。」 Two separate defects, one per sentence — and the first one had *three* independent causes, because the level was honoured on some paths and not on others.

### Fixed

- **`result` still streamed the answer into the live card as it was produced.** The level gated reasoning text and tool calls, but `applyStreamChunk` pushed every `text-delta` unconditionally — so the one thing the user had explicitly turned off, a running narration of the turn, was the one thing that always came through. The answer is now captured into `lastText` (silently, because the runner falls back to it when the settled events carry no answer, and dropping it there would turn a deliberately quiet turn into an empty one) and delivered once at the end. The `block-end` fallback for short blocks obeyed the same rule, or a short answer would still have leaked into the card.
- **The progress watchdog ignored the notification level.** It is gated on the level exactly like the liveness heartbeat now. This was the subtlest of the three: a turn that ran longer than `progressTimeoutMs` kept writing 「仍在处理中」 milestones into the streaming card no matter what the level said — so 「只输出结果」 was a lie for exactly the long tasks where it matters most. The heartbeat had been gated since it was written; the watchdog, added later, was not.
- **The final result was clipped at 300 characters.** Both the task-end stats card and the failure/abort summary called `truncate(outcome.text, 300)`. Under `result` — where that card is the *only* place the answer appears — a long answer therefore shipped as its first third and read as the agent having stopped mid-sentence. Both cards now carry the whole answer.

### Notes

- **`result` now means what it says.** 「只在任务结束后发送最终结果」: nothing is typed into the live card while the turn runs, and the answer arrives once, whole, on the task-end card. The streaming card is still opened (the turn's progress is still observable in the Web GUI) — it simply stays quiet.
- **`progressTimeoutMs` has no effect at `result`.** The config table said the watchdog reports a milestone after the interval with no mention of the level; it now states the exception, because an interval that silently does nothing is the same class of surprise this release is fixing.

### Testing

- **596 tests, 30 suites, all green** (was 592 in 30), plus SMOKE OK and E2E OK. Four new tests, and each was verified to go red against the code it is meant to catch — a regression test that cannot fail is worse than none:
  - `unit.test.mjs` replaces the old "result streams only the answer" expectation (which had *encoded the bug*) with three: `result` pushes nothing while capturing the text, the whole-block fallback obeys the same rule, and `full` still streams live.
  - `runner.test.mjs` **K2** asserts nothing reaches the card at the default level *and* that the answer still arrives on the task-end card — the second half rules out an implementation that passes by simply dropping the output.
  - **K4** runs a 400ms watchdog interval on a chat left at the default level and asserts no milestone appears.
  - **K5** scripts a 400-character answer with a unique tail and asserts the tail is delivered.

## [1.0.5] - 2026-10-06

The second half of 1.0.4's bug report: 「需要明确显示插件的设置，并能有效保存。还有也要显示出具体的连接状态。包括其他的可配置项，配置的值也需要能正确保存，显示。」 1.0.4 made the pane's saves *reach* the host; this one makes them *say what they did* and stops the pane from quietly discarding the settings it was showing. Three things were wrong, and only the first was visible.

### Fixed

- **A declared config key that the pane did not render was deleted on the next save.** `sectionOf` projects the channels section through a per-field allowlist, and `replace()` — the write path every real install uses — *resets* rather than merges: a key missing from the projection is not preserved, it is reset to its inherited value. Anything the schema declared but the field table omitted therefore vanished the first time the user saved anything. Feishu lost `threadIsolation` and `onboarding`; DingTalk lost `stream.url` and `stream.requireMention`. The pane's own form is built from the same read, so this was reachable without touching a single control: open the pane, press 保存, and two settings were gone.
- **DingTalk's `defaultAt` was rendered as `[object Object]` and written back as that string.** It was declared `kind: 'text'` while holding an object of three lists, so displaying it was already wrong — and because the field was also in the save payload, saving the pane *replaced the object with the literal text*. This was the one case where showing the setting was worse than hiding it. It is now carried through verbatim and deliberately not rendered (see below).
- **Feishu's `verificationToken` and `encryptKey` could not be edited at all.** The webhook transport reads them, the schema declares them `role("secret")`, and no form field, no credential entry and no migration path existed — a webhook-transport install had to be configured by hand-editing the profile. They are now masked inputs that write to the credential store and never to a config file.
- **`withOutboundRetry` dropped `sendFile`, so `/send <path>` never sent a file on any channel.** The wrapper is a rebuilt object literal carrying a fixed set of members; `sendFile` was not among them. The adapter the runner holds is the wrapper, so `this.adapter.sendFile === undefined` was always true and every `/send` fell back to posting the path as text — a failure that reads as a wrong answer rather than an error.
- **`withoutSecrets` filtered by key name and therefore missed nested secrets.** DingTalk's `clientId`/`clientSecret` live at `stream.clientId` / `stream.clientSecret`, so a config carrying them was copied into the snapshot verbatim: the secret crossed to the browser in clear text on the file-backed plane, and the pane — which rebuilds its save payload from that same object — wrote it back into the config on the next click. The filter now removes each credential at its *config path*, via the one table that knows the difference between a credential's name and where it lives. **This was found by the new sweep test below, not by reading the code.**

### Added

- **A second badge on every channel card: 接入状态, beside the credentials badge.** Until now the header answered only 「凭据是否已配置」, which is a different question from 「机器人现在连上没有」 — a channel with a valid appSecret and dead connection looked exactly like a healthy one. The new badge reports `已连接 / 连接中 / 重连中（第 N 次）/ 空闲 / 运行中 / 未运行 / 接入失败 / 未启用`, and the credentials badge is untouched.
  - **Feishu reports its real transport state** (`LarkChannel.getConnectionStatus()`), including the reconnect attempt count while it is reconnecting.
  - **The other three channels deliberately do not.** They have no probe to ask, so they report only what the runtime can evidence — 未启用 / 未运行 / 接入失败 / 运行中. Inventing 「已连接」 for a channel nobody asked would be the same class of lie as the missing-schema bug 1.0.4 fixed.
  - **A host that cannot report access state renders no second badge**, rather than an 「未知」 placeholder, and when a channel fails the existing issue bar carries the adapter's original reason.
- **The channels view polls every 5 seconds while it is open, and merges only the status keys.** A reconnect that happens while the user is looking at the page appears on its own. Merging just `channelStatus` is what keeps the poll from clobbering edits that have not been saved yet, or wiping a save-failure line the user has not read; a hidden tab skips the tick.
- **`test/channel-config-coverage.test.mjs` — the completeness check that makes this class of bug impossible to reintroduce.** It drives off the schemastery introspection rather than a hand-written list, and reconciles both directions: every declared `Config` key must be exactly one of *editable*, *secret* or *carried through*, and every entry in the credential table must be a `role("secret")` leaf in the schema. It was verified to go red — removing one field from the table fails it by name — because a completeness test that cannot fail is worse than none.
- **`test/settings-service.test.mjs` — a leak sweep derived from the credential table.** Every channel, every declared secret, planted both at its config path and in the credential store, then read and saved across both data planes. It asserts the value is absent from the config the pane re-emits, that the channel still reports the key as *stored* (a filter that stripped the flag too would send the user to re-enter a secret they already have), and that the preview is masked — with identifiers (`appId`, `clientId`) exempt **by design**, because `disclosureOf` shows them in full so the user can tell a correct id from a typo.

### Notes

- **The 接入状态 badge costs no hook slot.** The pane's React stub implements three hooks and reads its state positionally, so the badge rides on the existing form state — the same constraint that shaped 1.0.2's navigation.
- **`defaultAt` is carried through, not editable, on purpose.** Making it editable means a sub-form for `mobiles`/`userIds`/`all`; this release only guarantees it is no longer corrupted and no longer silently dropped.

### Testing

- **592 tests, 30 suites, all green** (was 546 in 28), plus SMOKE OK and E2E OK. The two new suites are `channel-config-coverage` and `channel-status`; `channels.test.mjs` also gains direct assertions on the new dotted-path helper, including that it never reaches into the object it was handed — the aliasing bug that would silently strip a live credential would otherwise be invisible, because the filtered copy looks correct either way.

## [1.0.4] - 2026-10-06

A one-line bug report: 「在设置了飞书的配置并保存后，还是提示未设置。也没有显示接入状态。」 — the Feishu credentials were typed into the pane, the save button was pressed, and the channel came back 未设置 with no 接入状态 row at all. Both halves of that sentence were true, and they had two independent causes, one on each side of the RPC seam. **1.0.3 shipped a plugin that could not be configured at all**, and the whole suite was green when it went out.

### Fixed

- **The plugin's `Config` schema was not on the object the loader reads — every pane write was refused.** cordis resolves a plugin entry to `unwrapExports(mod)` = `mod.default ?? mod`, then builds the runtime as `{ name, callback, fibers, Config: plugin.Config }`. `Config` was a *named* export of the module, and the moment a `default` exists the namespace is no longer the plugin — so `plugin.Config` was `undefined`, `runtime.Config` was `undefined`, and `dsh-settings` decides an entry is configurable from exactly that field (`schema(entry) { const schema = entry.fiber?.runtime?.Config; … }`). Its `write()` throws `No configurable plugin entry "connect"`. The pane's first save call is `settings.save`, so it threw on the first click, and every save after it. The same missing schema also made the `.volatile()` declarations on the ten 通用设置 keys a **no-op**: with no schema `resolveConfig` returns the raw config unchanged, `volatileEntries` finds no references, and every save degrades to a full remount. The fix is one property on the default export (`export default { apply, name, inject, Config }`), with the reasons written into the code at that line, because this is the second time that line has silently swallowed a reported bug — 0.9.x had the same shape with `apply` missing instead.
- **The pane's save treated two independent writes as one atomic operation.** The save button writes two documents: the config section (`settings.save`) and the credential store (`credentials.save`). One `try`/`catch` wrapped the pair, so when the config write threw, the catch jumped straight to the error status and **the credential loop below it never ran at all**. The appId and appSecret the user had just typed were discarded without a word, and the single message the pane showed — 「保存失败」 — cannot be told apart from a secret that was written and then refused by Feishu. The two halves are now attempted independently and each reports its own outcome as its own line on the save bar: 「配置设置未保存，请重试。」 / 「凭据未保存，请重新输入后再保存。」 (the host's own error code is appended, which is the only part that separates a refused write from a dropped connection). Neither half can discard the other's input any more: the form is re-seeded from a snapshot **only when both halves landed** — seeding from a snapshot taken after a failed config write would replace what the user typed with the state they were trying to change — and the credential half refreshes the channel's 接入状态 badge from whatever snapshot did land, so a stored credential shows even when the settings write failed.

### Added

- **A refused write now leaves a line in the host log.** `createSettingsRpcHandler` takes an optional `logger.warn` and records every failed call, including the ones mapped to a *public* code — the specific reason (`not-configured` naming which ref, a non-volatile path, a missing profile entry) lives in the message, and the message never reaches the pane, because an unrecognised host error is deliberately flattened to the generic `settings-failed`. That flattening is the right call; it was only unsound while the cause was recorded nowhere. Without this, the bug above would have been diagnosed from the user's description alone, since 1.0.3's host log said nothing when the write was refused.
- **`test/plugin-export.test.mjs` — the loading contract, tested as DSH performs it.** Every other suite imports the named exports and calls `apply` on a context it built itself. That is the right way to test behaviour and it is *blind to this whole class of defect*: it never runs the two loader steps that happen before `apply` is reachable. The new suite models them faithfully — `unwrapExports` → `ctx.registry.plugin()`'s `runtime.Config = plugin.Config` → `dsh-settings`'s `"toJSON" in schema` probe → the host's synchronous `~standard.validate` — and asserts that the default export carries the four fields the loader reads off it, that the named `Config` and the plugin's `Config` are **one object rather than two equal ones**, that an empty config still validates and still activates every channel, that every field the pane edits comes back as a live `{ get, [Symbol.for("cosmokit.volatile.write")] }` reference (the other half of what a working write path depends on), and that a stale profile — unknown top-level keys, a dropped channel option, credentials we keep out of the pane's field set — still loads untouched. Registering `Config` is what makes the profile config validated at load time, and a `ValidationError` there costs the user the whole plugin, so that last test is the cost of this fix stated as an assertion.

### Notes

- **The loading bug was invisible to a green suite for a real reason, not a coverage-count reason.** No unit test can catch it by importing the module: `import * as mod` and `import { Config }` both see the named export and work fine. The defect only exists in the difference between the namespace and the *default object*, which is a property of how the module is consumed, not of what it exports. Catching it required writing a test that consumes the module the way the loader does, which now exists.
- **Nothing about the settings seam changed.** The RPC channel, the endpoints, the payload shapes, the public error codes, the write path, the file lock and the comment preservation are all as they were. This release is one missing property, one split `try`/`catch`, and the logging that would have found it sooner.

### Testing

- **546 tests, 28 suites, all green** (was 538 in 27; the new suite is the 28th), plus SMOKE OK and E2E OK. The two new bundle tests are the ones that pin the fix from the user's side: one has the host refuse the config write and accept the credential, and asserts the credential still landed, the channel badge flipped, the typed secret is still in the input, and exactly one line is on the save bar — the settings one, carrying `settings-failed`; the other refuses the credential write and asserts the line names the credential and the channel, and that the value the user typed survived.
- **Re-verified against a live throwaway `dsh web` boot**, which is how the defect was reproduced in the first place: `credentials.save` returns `true`, the snapshot reports `live: true` with `credentials: { feishu: true, … }` and `secretPreviews: {"feishu":"appId,appSecret"}`, `credentialErrors` and `channelErrors` are empty, and the whole host log contains no diagnostic lines and no credential material beyond the masked previews.

## [1.0.3] - 2026-10-04

A documentation release, cut because 1.0.2's documentation contained a claim that was **false in the direction that costs a user time**: it said a settings save takes effect without restarting `dsh`. That is true of the channel settings and untrue of everything the new 通用设置 view is for — those ten values are read once, when the plugin loads, which is exactly why 1.0.2's own pane labels each of them 「重启后生效」. The claim was in all four READMEs (the repository pair and the package pair) and in both QUICKSTARTs, and the package README pair is what the npm page is generated from, so it was reaching users on the install page at the same moment the pane was telling them the opposite. The rest of the release is the same audit applied to every other document that still described the pane the way it looked before 1.0.2 — and one entry that described a release that never happened. No code is in this release: the only non-`.md` files that changed are the two `package.json` versions and the two `README.i18n.yaml` hashes.

### Fixed

- **「保存无需重启即可生效」 / "a save takes effect without a restart" — narrowed to what is actually true.** The four READMEs and both QUICKSTARTs now say that **channel settings take effect immediately, and the general settings do not**, naming the keys that wait for a restart (`workDir`, `language`, `notifyLevel`, `progressTimeoutMs`, `workspaces`, the two allowlists, `agentPreset`, `streamHeartbeatMs`). This is the same distinction the pane has shown on each row since 1.0.2; the documents were the last place still stating the unqualified version. Anything else about the seam — atomic write, file lock, comment preservation, volatile declare/reconcile — is unchanged and still accurate.
- **The pane's path, named correctly.** 1.0.2 gave the pane a two-level navigation, so 「设置 → 通道」 is no longer a path a user can follow: it is **设置 → dsh-connect**, then **通用设置** or **机器人渠道** (English: **Settings → dsh-connect**, **General** / **Bot channels**). Corrected in the Feishu setup pair (`docs/feishu-setup.{md,zh.md}`), both QUICKSTARTs and `docs/all-in-one-and-web-settings.md`, including the one place the old name was being shown as the pane's registration identity rather than as a path.
- **`docs/all-in-one-and-web-settings.md` no longer implies 1.0.1 shipped.** It described 1.0.1 as a released documentation revision; 1.0.1 has no tag and never reached npm (see its entry below), so the status page now says so and the pane description there matches 1.0.2's two-level navigation.

### Notes

- **Stale version footers and counts, corrected**: `docs/ROADMAP.zh.md` (baseline 0.9.3 → 1.0.2; its test count, which predated the all-in-one consolidation, 441 → 538), `docs/SHARED_WORKSPACE_SETUP.{md,zh.md}` (footer v0.9.3 → v1.0.2, plus the restart distinction above and a note that the pane's `workspaces` **merges with** a shared config's `additionalWorkspaces` rather than being shadowed by it — unlike `workDir` / `language` / `autoMirror`, which really are shadowed and get the dynamic provenance note), `docs/MIRROR_SESSION.{md,zh.md}` (the command table's `(v0.9.0)` heading → `(since v0.9.0)`; the four commands are unchanged, the label was reading as a currency claim), and `docs/PUBLISHING.zh.md` (an image `alt` that still described the pane as the pre-1.0.2 tab strip, while the English twin already described the primary navigation).
- **Left alone on purpose**: `docs/WEB_MIRROR_IMPLEMENTATION.{md,zh.md}` and `docs/ENHANCEMENTS_SUMMARY.{md,zh.md}`. Both are dated implementation records of a specific version (v0.9.0 and v0.6.2 respectively) rather than descriptions of the current product, and rewriting a record of what was true then would make it a worse record. `packages/connect/README.md`'s 「`0.9.3` is the version that covers `0.2.0-rc.2`」 is still literally correct — 0.9.3 is the floor of that range, not the current version — and its troubleshooting rows cite 0.9.3 as a fix version, which is a historical fact about when each fix landed.
- **Both `README.i18n.yaml` manifests re-recorded.** Four READMEs changed, so both pairs' blob hashes were re-recorded against the new bytes; the consistency check compares working tree to manifest exactly, and a stale hash reports a mismatch that is not there.

### Testing

- **Docs only — no test or bundled file changed.** The connect suite is unchanged at 538 tests / 27 suites, re-run green on this commit, which is also what validates the re-recorded i18n hashes and the byte-clean `package.json` version lines.

## [1.0.2] - 2026-10-04

The settings pane stops being only about channels. The report that started this was an ordering complaint: 「一键创建这个设置要在最前面，要不然用户逐项设置到最后，发现有一键创建机器人，不得疯了」 — and the second half of it was that the values a user changes most often were the ones the pane could not show at all: 「还有默认设置，就是我们原来通过命令进行的那些设置值，在这也要能直接查看。比如选择的模型、回复的简略程度等等」. So the top of the pane became a **primary navigation** — 通用设置 first, then 机器人渠道 — the one-click button moved above the fields it fills in, and the ten values that previously required remembering a chat command now have a card each. The release is a minor one, not a major one, for a reason worth stating: nothing new can leave state behind in an account we do not own. But one thing here can *destroy* state, and it is the part that took the longest — see 「the save is a section, and a section resets」 below.

### Added

- **通用设置 — the ten values that used to be chat-command-only.** 语言 / 通知级别 / 进度提醒时长, 工作目录 / 工作区列表, 用户与群白名单, 智能体预设 / 自动镜像 / 心跳间隔 — four cards, grouped exactly as they resolve, all editable through the same `SettingsForms` seam the channel cards use. They are declared `.volatile()` on the plugin's `Config`, which is what makes the pane able to commit them at all; they are **not** added to `paneConfigFields()`, where the untyped `z.any()` leaves would have overridden their real constraints (`z.union([z.const("zh"), z.const("en")])` and the like) rather than merely projecting them.
- **A read-only row for the model, and the reason it is read-only.** DSH's current default (`agentDefaultModel.currentSelection()`) is shown as text with 「此值由 DSH 管理，请在 DSH 里切换」 — no input, and no write path anywhere in the pane. `saveSelection()` exists and is exactly what `/model` and `/reasoning` call, so a write would have taken ten lines; it is deliberately not wired, because that selection is DSH-wide and shared with every other session and plugin, and a settings pane silently moving it would change other people's runs as a side effect of editing the Feishu bridge. The absence is written into the code at the point where someone would be tempted to add it back.
- **The shared-config provenance note.** A `dsh.shared.config.json` above the workspace shadows `workDir`, `language` and `autoMirror` (`src/service.ts`), so on a machine that has one, editing those three rows would appear to do nothing. The host now reports which keys are actually shadowed and the pane prints a note on exactly those rows — dynamically, so a clean install has no note and no disabled control, and the fields stay ordinary editable fields. `workspaces` is deliberately **not** in that list: the shared config *appends* to it (`additionalWorkspaces`) rather than overriding it, so a pane edit there really does take effect, and it gets a static hint saying so instead.
- **A one-click button at the top of the Feishu card**, above the credential fields it exists to spare you from. Telegram's and DingTalk's 「create the app」 links moved up for the same reason in reverse — their text says 「把下面拿到的东西粘上去」, so the link has to come before the fields it points at.

### Fixed

- **The save is a section, and a section resets — the reason `sectionOf` is now the load-bearing projection.** `SettingsForms.replace()` resolves every field it is *not* handed back to its inherited value, so a key missing from a save payload is not "unchanged", it is **erased**. The one-click enable write is the sharpest edge of that: it reads the live config, projects it, and writes the whole thing back (`enableFeishuConfig` is a whole-section spread, `return { ...section, channels, feishu }`). Before this release the general keys were not part of that projection, so **pressing the one-click button — or saving anything at all from the channels view — would have silently reset all ten of them.** `sectionOf` now projects them, and `mergeSections` starts from `{ ...base, ...override }` rather than rebuilding the section key by key, so the legacy-import path (which is always `mergeSections(current, legacy)`) cannot drop a general key either. Pinned by a test that feeds a fully-populated config through the exact `sectionOf(materializeConfig(...))` → `enableFeishuConfig(...)` sequence `index.ts` uses and asserts no key is missing from the payload.
- **The version bump no longer corrupts `package.json` — and 1.0.2 is the release that would have shipped it.** `scripts/bump-version.ps1` rewrote the manifest through `ConvertFrom-Json | ConvertTo-Json` and saved with `Set-Content -Encoding UTF8`, which on Windows PowerShell 5.1 means *UTF-8 with a BOM*. DSH parses plugin manifests with a strict JSON parser, so a manifest whose first three bytes are `EF BB BF` does not fail loudly at the field level — it prints `skipping profile bundle "dsh-connect": SyntaxError: Unexpected token '', "{ "n"... is not valid JSON` at startup and **skips the plugin entirely**. The package publishes fine, installs fine, and does nothing. Nothing in this repo's test suite could see it: `require()` strips the BOM (so the obvious sanity check reported "healthy"), the fixtures never read the file, and `npm pack` is indifferent. It was caught booting the screenshot harness for these very docs, and the fix is text surgery — find the one anchored top-level `"version"` line, replace the value in the original bytes, write with `[System.IO.File]::WriteAllText` and a `UTF8Encoding($false)` (no preamble), validating the result with a strict parse *before* it touches the disk. `test/manifest.test.mjs` now pins it: the manifest is parsed with `JSON.parse` on the raw text — the same parser DSH uses, which is the only one that agrees with it — and the bump script is checked for the two idioms by name, so the round trip cannot come back. The same bullet-point rewrite is also why a version bump used to touch all 117 lines of the file; it now produces a one-line diff.
- **`channelDefaults.notifyLevel` removed. It was dead.** No channel adapter ever read it — the adapters read `config.language`, and the runner's `notifyLevel` comes from the top-level resolved config — so the pane was rendering a control that appeared to do nothing. The real global value is now editable in 通用设置 (as `notifyLevel`), and the channel-level `language` stays where it was. **Write impact on existing profiles, stated rather than glossed:** a profile that has this key will lose it the next time it saves through the declared section. That is a visible change to someone's settings file with no behavioural effect, which is why it is here and not in a commit message.

### Notes

- **General settings take effect after a restart.** There is no config hot reload and this release does not add one: `ConnectService.config` resolves once at construction and the runner copies `workDir` / `language` / `notifyLevel` / `progressTimeoutMs` into instance fields, while `reconcile()` feeds only the channel runtime. Rather than ship a control that appears to do nothing, every general field's hint says 「重启后生效」 — and a test asserts that wording is present in both languages, so the honesty cannot be lost by a later edit.
- **An emptied list deletes the key rather than writing `[]`.** `workspaces` / `allowUsers` / `allowChats` are textareas, one entry per line; clearing one means "back to the inherited value", which is what an absent key already means. Writing `workspaces: []` would stamp noise into every profile that ever saved with the box blank, since a volatile array resolves an absent key to `[]` on the way back in anyway.
- **Navigation order and landing view disagree on purpose.** The strip is 通用设置 then 机器人渠道; the pane opens on 机器人渠道. Both are asserted, and `panel-state.mjs` carries a note not to "fix" one to match the other — a landing view aligned with the navigation order would put the one-click button behind a click again, which is the complaint this release exists to answer.

### Testing

- **538 tests, 27 suites, all green** (was 499). Both languages are mechanically checked against the field table: every general key needs a label, a hint, and a translated option label in `zh` *and* `en`, because a key present in one language only renders the other language's string silently.
- **The reset hazard has a reproducible probe, not an argument.** A config carrying all ten general keys goes through `sectionOf(materializeConfig(...))` → `enableFeishuConfig(...)`, and the test asserts all ten are in the payload handed to `save()` and still there on the subsequent read — alongside a channel config and a channel that the enable write has to preserve. This is the test that would have caught the bug this release is mostly about.
- **The two new snapshot fields are asserted to be absent when empty.** The pane's own tests deep-equal whole snapshots, so an always-present `agentModel: undefined` or `sharedOverrideKeys: []` would have been noise on the happy path — which is the common case for both.
- **The structural claims are pinned too**: the navigation is the pane root's first child and a `nav`; the save bar is the root's last child in **both** views; the one-click button's index is below the credential fields' index, not above; switching views does not change the channel tab count; the DSH-owned model renders as a read-only row and never as an input; and no rendered string is a raw locale key in either view.

## [1.0.1] - 2026-10-04

A documentation release, written from a user's bug report rather than from this repo's own audit — the first entry here of that kind. The report was two observations: the Desktop's plugin list offered **1.0.0**, and the install produced **0.9.2**. Neither half was a packaging fault. 1.0.0's tarball is correct, and the layout fixes it was published for *are* present in the 0.9.2 that landed on disk — which is exactly what made the report worth chasing instead of re-releasing. Reproducing it in a throwaway `DSH_HOME` through DSH's own installer turned up two independent pnpm 12 behaviours that had never been written down: a 24-hour release cooldown that a bare `add` silently obeys, and an undecided build script that fails the install *after* writing the dependency. A user cannot tell either one from a broken release, and the first one mimics a version mismatch precisely. Both are now documented — in the repository READMEs, and, because the npm page is generated from the package README, in that pair too. A fix that lives only in the repository is a fix the affected user never sees.

**This entry was never published on its own.** There is no `v1.0.1` tag, npm never saw 1.0.1, and the registry goes 1.0.0 → 1.0.2. The work described below was finished and version-bumped but the release was not cut, so it went out inside 1.0.2 instead. The entry is kept rather than renumbered because the reasoning is worth more than the version number, and nothing is lost by the fold: the npm page is generated from the package README at whatever version publishes, so the install documentation this release is about reaches the affected user through 1.0.2 exactly as it would have through 1.0.1. Read the two entries as one release window.

### Added

- **The READMEs explain 「the list offers the new version, the install takes the old one」.** `minimumReleaseAge` defaults to 1440 minutes and applies **non-strictly**, so for a full day after every publish a bare `dsh plugin --profile web add dsh-connect` resolves to the previous release. The reason this reads as a lie rather than as a delay is that the Desktop's version display is a **query**, and a query is not subject to the policy: for one day after each release the two legitimately disagree. That asymmetry is the diagnosis, and it is the one thing the section states first.
- **The remedy is narrow, and the section says why.** `minimumReleaseAgeExclude: [dsh-connect]` exempts this package alone; `minimumReleaseAge: 0` would exempt every dependency in the profile from the same 24-hour supply-chain protection to solve a problem with one of them. The second half of the fix — `allowBuilds: {protobufjs: false}` — is required for a reason that has nothing to do with the cooldown: `protobufjs`, reached through `@larksuiteoapi/node-sdk`, carries a build script pnpm 12 refuses to run undecided, and it reports that **after** writing the dependency, so the failure looks like a half-finished install. `onlyBuiltDependencies` and `ignoredBuiltDependencies` are no longer accepted spellings and still fail with the same error.
- **A Troubleshooting row in both package READMEs**, where someone hitting the error actually lands, pointing at the section. The root pair keeps the install-adjacent placement instead, since that is where its readers are when they run the command.
- **`docs/PUBLISHING.md` / `.zh.md` §3.1 — the cooldown, from the publisher's side.** Expect this report within 24 hours of every release and check the registry before debugging the tarball; and for a **first** install of a package with no release older than 24 hours there is nothing to fall back to, so the exemption is mandatory rather than preferable. It also records that neither problem can be fixed from inside the published package.

### Fixed

- **Two stale numbers in the docs, found while levelling them.** `docs/all-in-one-and-web-settings.md` claimed the suite was **498** tests in three places; the 1.0.0 entry above records 441 → **499**, and running the suite reports 499. Corrected. `.cursorrules` said the root `package.json` "usually stays at 1.0.0" — it has in fact been bumped with every release since 0.6.7, by hand, because `bump-version.ps1`'s `$PackageFiles` lists only `packages/connect/package.json`; the note now says that, so the next release does not skip it.
- **The first draft of the section overstated what a version pin buys.** It said an explicit `dsh-connect@<version>` was an alternative to editing the profile; testing it showed the pin defeats the cooldown and does **nothing** for the build script, so that install still exits `ERR_PNPM_IGNORED_BUILDS` with the dependency written. Both pairs now say so, and say what the pin is actually worth: the right version, but not a clean exit. The claim was corrected before publication, and it is recorded here because the correction is the more useful fact — the two traps are independent, and a fix for one is not a fix.

### Testing

- **The install half, through DSH's own installer in a throwaway `DSH_HOME`.** Unmodified profile: `+ dsh-connect 0.9.2` — the user's symptom, reproduced. With the two lines above: `+ dsh-connect 1.0.0`, exit 0, no `ERR_PNPM_IGNORED_BUILDS`.
- **The two traps are independent — pinned by direct test.** `pnpm add dsh-connect@1.0.0` in a bare workspace with no exemption installs exactly `1.0.0` and still exits 1 on `ERR_PNPM_IGNORED_BUILDS`. That single run is what falsified the first draft of the docs.
- **The exemption cannot ship inside `dsh-connect` — verified, not assumed.** A fixture package carrying `"pnpm": {"onlyBuiltDependencies": ["protobufjs"]}` in its own manifest still produced the error in its consumer, which is why the fix is documented as belonging to the consuming profile and why no runtime change accompanies this entry.
- **The layout half of the report, against the published artefact.** The same scratch install was booted and driven with Playwright: `.ds-fields` computes to a single `512px` track (no `auto-fill` rule survives in the stylesheet), 16 fields occupy 16 distinct rows, and the tab strip is `position: sticky; top: 0` as a direct child of the pane root, moving `0px` when the scroll host is advanced 700px. So the 1.0.0 the user *did* get already contains both layout fixes — the complaint was a version-identity problem, not a missing change.

## [1.0.0] - 2026-10-03

The settings pane stops being a form and starts doing work. Three requests, one theme: everything the user said was about *reading* the pane — 「不要两列的处理，一行就一个设置项，变成一行两列后更乱了」, 「顶部的导航标签不要随着滚动，固定在那」 — and the third was about never having to open the pane's hardest tab at all: 「增加一个一键自动配置机器人的处理…点击后，用户可直接给自己的飞书机器人发信息了」. The two layout fixes are small and mechanical. The one-click flow is the reason this is a major release: the pane now asks the host to create an application in the user's own Feishu tenant, declare its permissions, store the credentials, set its event subscription and enable the channel — six steps, five of which can fail independently, spread over the several minutes a human takes to scan a QR code. A single RPC response cannot span that, so the flow is `start` (answers with a link, immediately) + the pane polling `status` until a terminal phase, and **every step reports its own result**. The outcome type that carries those results has no "success" field on purpose: the pane renders one line per true fact, so a run whose credentials landed but whose adapter did not reload says *both*, and a run that created an app and then died still tells the user the app exists in their tenant. That is the same rule the last two releases were about, applied to the first feature that can leave real, half-finished state behind in an account we do not own.

### Added

- **One-click Feishu bot creation.** A 「一键创建并配置飞书机器人」 button in the Feishu card runs the flow the CLI already had (`registerApp`, OAuth 2.0 device authorization, `appPreset` `DSH 助手`) but which `dsh web` could never reach — the adapter's gate is a TTY check and the web host is headless. On success the app exists in the user's tenant, its credentials are in the credential store, `feishu` is in `channels`, `transport` is pinned to `websocket`, and the running adapters have been reconciled — so the bot answers a direct message without a restart. The whole flow lives in the host (`src/settings/feishu-onboarding.ts`, a per-process single-flight registry): the credential store and the config write are not reachable from the browser, and the link is issued minutes before the result.
- **Three RPC endpoints — `onboarding.start` / `onboarding.status` / `onboarding.cancel` — and the rule that shapes them.** `start` returns as soon as the flow is running, carrying the device-authorization link; the flow then lives in the host process and the pane polls. The alternative, one long request, is not merely awkward: the settings HTTP handler aborts its request on `res.on("close")` (`settings-rpc.ts`), so a page refresh, a re-render or a closed tab would abort a **single-use, single-person** device-authorization link and burn the user's only chance to scan it. The request's `AbortSignal` is therefore never wired into the flow — only the pane's explicit 「取消」 reaches `registerApp`'s `signal`, where it genuinely stops the poll and invalidates the link. This is written into the code at the point of use, and pinned by a test asserting the handler's signal is not in the arguments the flow receives.
- **The outcome is a list of facts, not a verdict.** `OnboardingOutcome` reports `created` + `appId`, `credentialsStored`, `legacyMirrorWritten`, `enableRequested`, `applied: "pending" | "yes" | "no"`, and a four-state `subscription`. `onboardingIssues()` (`client/panel-state.mjs`, pure and separately tested) turns it into one line per true fact — an app that exists is announced even when every later step failed, and `credentialsStored: true` with `applied: "no"` renders as two lines, never one 「已保存」. The reason strings the host produces are appended verbatim in parentheses rather than paraphrased.
- **`src/settings/app-config.ts` — the event-subscription mode, set as best effort.** `registerApp`'s `addons` can declare permissions, events and callbacks, but not the subscription *mode*: that is a sensitive application setting and needs its own `application/v7` PATCH. It is attempted, and both of the API's own caveats are surfaced rather than smoothed over — see the limits below. A refusal is reported with Feishu's own `code: msg`.
- **`enableFeishuConfig(section, allChannels)`,** a pure exported function that composes the enable write: the *complete* declared section with `"feishu"` added to `channels` and `feishu.transport` pinned to `"websocket"`. Exported for testability, and that is the honest reason — the alternative was an inline closure inside `apply()` whose only route to a test is a live `registerApp` against Feishu, so the completeness rule (a partial write on this seam is a **deletion**) would have had no test at all.
- **`OnboardHooks` on `onboardFeishu` — `onQRCodeReady`, `onError`, `signal`.** All optional, so the CLI path (`register()` → `onboardFeishu(logger, language)`) is byte-for-byte what it was; the non-optional version of these hooks is why the link previously existed only as a log line.
- **A single row per setting, and a tab strip that does not scroll away.** `.ds-fields` moves from `repeat(auto-fill, minmax(200px, 1fr))` to a single column, which fixes all three of its call sites at once (the channel cards, the advanced fold, and the shared-defaults card). The strip is hoisted out of the first card to be a direct child of the pane root — `position: sticky` pins to the nearest scrollport only while the element's containing block *is* the scrolled box, which is the same reason the save bar was moved out of a card in an earlier release — and given a background, a hairline and a `z-index`.
- **The other two channels get an official-entry link and a plain sentence.** Telegram and DingTalk have no bot-creation API (one is created in a chat with @BotFather, the other in a web console), so their cards say so and link to `t.me/BotFather` and `open-dev.dingtalk.com`. Stated rather than faked.

### Fixed

- **A credential save that wrote nothing reported success.** `channels/feishu/index.ts` passed `{appId, appSecret}` to `credentialStore.save("feishu", …)`, but that method looks each value up by its credential **ref** (`DSH_CONNECT_FEISHU_APP_ID`, `DSH_CONNECT_FEISHU_APP_SECRET`) — a map keyed by *config* key matches nothing, writes nothing, and returns cleanly, so the surrounding `try` set `stored = true` and the flow reported a credential that was never stored. The keys are now derived from `CHANNEL_SECRET_KEYS.feishu` so the two spellings cannot drift, and the new one-click flow uses refs from the start.
- **A finished flow no longer leaves a dead link on screen.** `finish()` retires the link along with the phase. A terminal phase means the link was scanned, cancelled or expired, and the pane renders a link on its *mere presence* — so keeping it would have put a dead URL, inviting a scan, directly beside the line saying the flow is over.
- **The enable write is a complete section.** The one-click flow reuses the same `save()` a pane save uses, and on that seam an omitted declared field is reset to its inherited value: a fragment would have dropped every other channel the user had enabled, and the `feishu` fields the user had set by hand, at the moment they clicked a button that was supposed to *add* something.
- **`applied` cannot report `yes` off a reconcile that had nothing to apply.** If the enable write itself failed, the channel was never enabled and the reconcile proves nothing about it; the outcome is forced to `no` rather than crediting a re-apply that had no new configuration to adopt.
- **`README.i18n.yaml` had been recording a hash of nothing.** The root manifest's `README.md` line held a **39-character** value — one short of a SHA-1, and therefore the hash of no file that can exist. It was never compared against anything, so it survived every release since it was written; found while re-recording the pair for this release. A truncated hash reads exactly like a real one, which is what let it hide: the failure it conceals is a manifest asserting that the bilingual pair was consistent while being unable to prove it. Both manifests now verify, and the new `test/readme-i18n.test.mjs` asserts the recorded value against `git hash-object` **and** its length, so the same typo fails immediately instead of a year later. Nothing about this file was ever load-bearing at runtime — which is precisely why nothing noticed.

### Testing

- The flow's five failure boundaries are pinned one at a time, in `test/feishu-onboarding.test.mjs` (new: 28). `test/settings-rpc.test.mjs` (12 → 19) covers the three endpoints' dispatch and payload shape, the `unsupported` answer for a host with no registry, and — the one that matters most — that a poll from a reloaded page still receives the same unburnt link, with the handler's abort signal asserted absent from the flow's arguments. `test/panel-state.test.mjs` (12 → 24) pins `onboardingIssues`: one line per true fact, keys derivable from the code and free of indices, `credentialsStored` + `applied: "no"` producing two lines rather than a collapsed one, `pending` and `no` distinct, the four subscription states distinct, `needsManual` only on a strict `true`, and the pre-creation `reason` field reported only for a run that never created anything. `test/client-bundle.test.mjs` (18 → 26) renders it end to end: the button appears in the Feishu card body, the link arrives as selectable text with **no QR-code node** — an assertion that fails the day someone adds a QR library to solve a problem Feishu's own page already solves — and a half-applied run puts both halves in the save bar. `test/web-settings-roundtrip.test.mjs` (2 → 4) drives the whole thing over the wire, asserting that the secret goes in and never comes out: the pane's preview is not the secret and does not contain it, and no reply in the transcript serialises it. `test/feishu.test.mjs`, `test/locale.test.mjs` and `test/settings-service.test.mjs` are unchanged in count (43 / 12 / 23) — the CLI path's existing assertions had to keep passing verbatim, which is what makes "the hooks are optional" a claim with evidence behind it. `test/readme-i18n.test.mjs` (new: 1) compares both `README.i18n.yaml` manifests against `git hash-object`, and skips — loudly, and only — when there is no `.git` to hash against, as in an exported tarball. 441 → 499 tests, all passing.

### Documentation

**The limits of the one-click flow, stated plainly:**

- **The subscription PATCH may refuse the app this flow just created.** Feishu's own API doc says the endpoint 「仅支持更新开发者后台创建的自建应用，不包含通过机器人助手等其他渠道创建的自建应用」, and the SDK never documents which channel `registerApp` uses. So it is attempted, a rejection is caught and printed with Feishu's own `code: msg`, and the outcome says the subscription still needs manual attention. Nothing claims otherwise.
- **A successful PATCH is not proof the long connection is live.** Of the settings that take effect immediately only a few (whitelists) qualify; everything else needs a release submitted and approved. This release does **not** publish the application — `applicationPublish.create` is an administrator-visible action with approval semantics, far beyond what a settings-pane button should claim on the user's behalf.
- **Card-button delivery under long connection depends on the platform's app template** and is not something this feature sets; the callback half of the configuration is deliberately untouched, matching the README's note that long-connection mode supports event subscriptions only.
- **The one-click flow does not apply to the CLI/headless path.** The TTY gate in `channels/feishu/index.ts` is unchanged and headless `dsh web` still logs `onboardingSkipped` and returns. The pane's button is the only new entrance to onboarding, and it is allowed because a pane genuinely has a human watching — it just judges that condition differently. The gate should not be "fixed" by a later reader.
- **A browser refresh no longer kills the flow, but a host restart loses the result.** The pane stops observing it; re-calling `onboarding.status` gives back `waiting` and the same link. If the host process restarts mid-flow, the outcome is not recoverable — the registry is per-process.
- **`start` returning a link is not success.** The pane presents a sequence (link, then result) and must never render the arrival of a link as a completed run.
- **The plaintext legacy mirror still exists** (`$DSH_HOME/.dsh-connect/feishu-credentials.json`, written by `saveCredentials`) and is read by older builds. It predates this release and is out of scope, but the credential store must not be described as the only copy on disk.
- **A cancelled flow really is cancelled.** `registerApp`'s `signal` is honoured, so the pane's Cancel stops the polling and invalidates the link. It is not a UI gesture.

Also:

- **`docs/all-in-one-and-web-settings.md` carried a status block and test count from the previous release**, and both are updated; the pane screenshots are re-captured for the single-column layout, the pinned strip and the one-click button and result, from the same clean-room profile as the previous set (plugin linked to this working tree, every credential in it a fake placeholder).
- **`docs/config-reference.md` and all four READMEs name the shortcut and its boundary** — Feishu can be created in one click from the pane, Telegram and DingTalk cannot, and those two link to their official creation pages. The root and package READMEs each carry the note their audience needs: the root pair is what people read before installing, the package pair is what npm shows.
- **`docs/PUBLISHING.md` / `.zh.md` describe the new screenshot inventory** (ten PNGs, five names) and for the first time write down how a capture is actually made — a scratch `DSH_HOME` whose plugin is linked to the working tree, booted on `--port 0` because 3080 is likely the developer's real server, driven through Playwright against the pane element. The recipe previously lived only in the operator's head, which is how it would have been lost. Both files also record that there is **no** screenshot of a completed one-click run, and why: taking one means creating a real app in a real tenant.

## [0.9.3] - 2026-10-02

An audit of what this bridge does when a write fails, and the repair of every place it reported success anyway. The unifying fault is one shape in six places: a durable store refused or dropped a write, the `catch` that should have reported it was either empty or a bare `undefined`, and the user was told everything was fine. A reminder set for tomorrow disappears overnight, a chat stops being resumable after a restart, a rotated secret never reaches the running bot, and the one message the user sees in each case is 「已保存」 or 「已设置」. Each of those is now a reported outcome, and where the operation genuinely did succeed in part — the reminder is live in this process but not on disk — **the report says both**, because a single line covering half the truth is how the other half goes unnoticed. The same principle read from the other end produces the two chat-facing additions: a resume that silently fell back to a fresh session now says so in the conversation, and a task card the adapter could not deliver is logged instead of discarded.

### Added

- **The settings pane can report a problem instead of only a verdict.** `SettingsSnapshot` carries three optional fields — `warnings`, `credentialErrors` and `channelErrors` — and each is spread into the response only when non-empty, so a healthy snapshot is byte-identical to the previous release's. Credential-store read failures arrive as a channel-keyed message rather than as an all-false presence map, and adapters that failed to start arrive with the `start()` error that stopped them. The pane renders all three through one exported helper, `snapshotIssues()` in `client/panel-state.mjs`, as a single list in the save bar — the one part of the pane that is always on screen, and the reason it is not beside the channel it concerns is that a channel card can be folded or scrolled past, which is exactly when 「已保存」 next to nothing else misleads. A channel whose credential state could not be *read* also gets a distinct amber badge: "unknown" is a third state and not a shade of false, and collapsing it into 「未配置凭据」 sends the user to re-enter a secret that was never the problem. Warning codes render through `w.<code>`, so a code shipped without its locale entry prints the code — searchable, and visibly untranslated — rather than `undefined`.
- **`SETTINGS_WARNING_CODES`,** the list of codes the pane knows, as a real array (`["credentialsStoredNotApplied"]`) rather than a bare union type. The locale test derives its expectations from that array, so the list and the translations cannot drift apart.
- **A chat notice when the stored session could not be resumed.** `connect: resume of <id> failed, creating fresh session` was logged and nothing else; the log is the one place a chat user never looks. They send a follow-up into a conversation that looks intact and the reply arrives with no memory of it. The catch now records the reason (only when the binding held a non-empty `sessionId` — see the fix below) and, **after** the fresh session actually exists, sends 「⚠️ 无法恢复上次的会话，已为你开启一个新会话继续（旧会话仍可在 Web 端查看）」 plus the reason, so a permanent cause (a deleted session store, a moved work directory) is distinguishable from a one-off. The old session is not lost: it is still in the session store and still viewable in the Web GUI, which is why the notice says "continuing in a new one" rather than "your conversation was lost".
- **`BindingStore` reports a write failure on the transition, in both directions.** A binding file it cannot write means existing chats will not be resumed after a restart and each will start a new session — the same silent-fallback class as above, one restart later. The store now warns once when persistence breaks and once when it starts working again, rather than on every save. The same reporting is threaded through the two other stores that can silently refuse a write: `ReminderStore.add()` returns `{ reminder, persisted }`, and the Feishu onboarding credential save returns a `boolean`.

### Changed

- **The progress watchdog's tick is derived from the configured interval** instead of being fixed at `PROGRESS_WATCHDOG_CHECK_MS` (15 s): half the interval, floored at 250 ms so a pathologically small value cannot become a busy loop, capped so the 5-minute default keeps the same 15 s tick as before. A fixed 15 s tick meant `progressTimeoutMs: 30_000` was honoured anywhere in 30–45 s — up to 1.5× what the user asked for — and no test could observe the feature without sleeping the constant out.
- **`onCredentialsSaved` is awaited, and `namespace.onChange` may be async.** The credential write ends with the same `reconcile()` a config save triggers (the `0.9.2` fix); awaiting it is what makes the pane's report of that reconcile truthful rather than merely optimistic.

### Fixed

- **An unreadable credential store no longer reports as 「未配置凭据」.** The read loop's `catch {}` was empty, so an `EACCES` or a malformed store produced the same all-false presence map as a genuinely empty one, and sent the user to paste a secret that was already there. The failure is logged and carried to the pane as a per-channel message.
- **A channel that failed to start says so.** `channelErrors` is populated from the adapter's own `start()` error and cleared on a successful start and on stop, so the message in the pane is the one the adapter raised — the only part that names the credential or option actually at fault.
- **A reminder that could not be persisted is reported as set *and* as not surviving a restart.** The reminder is live in this process and will fire; a failed write means it will not survive a restart. 「已设置」 alone is how a reminder set for tomorrow quietly disappears overnight, and refusing to set it at all would be the lie in the other direction, so the confirmation line carries a second line naming the consequence.
- **An onboarding credential save that did not land no longer reports success.** `saveCredentials()` now returns a boolean and the flow has an `onboardingUnsaved` message for the false branch.
- **A first message in a brand-new chat no longer claims a session was lost.** `maybeSendWelcome` writes the binding with `sessionId: ""` *before* the first `ensureAgent`, so `resume("")` fails on every chat's first message with nothing to resume — an empty id is not a lost conversation, and the new notice is suppressed for it while the log line keeps telling the operator what happened.
- **A task-end card that could not be delivered is logged, not discarded.** `await …sendCard(…).catch(() => undefined)` made a dropped card and a card with nothing to say indistinguishable. It is neither: that card is the durable record of the turn — the result text and the token/duration summary — and the streaming card it replaces is meanwhile stuck on its last frame, so a silent failure left the user watching a frozen "running" indicator with no reason to think anything was wrong.
- **The pane no longer says a save lands in `settings.yaml`.** `0.9.2` moved the live store to this plugin's entry in the active profile patch; the status line under the Save button — the one string a user reads to answer "where did my save go, and when does it apply?" — kept naming the document DSH 0.2 no longer reads plugin settings from, so the pane was confidently pointing at the wrong file. It now names `cordis.patch.yml`, and the fallback plane's hint no longer calls the absent namespace "the `settings.yaml` namespace", since the namespace is registered against the host's settings service rather than that file. Found by re-capturing the settings screenshots against `0.2.0-rc.2` — both strings were terse, plausible and wrong, which is why a test that only checked they were *present* (the one that existed) could not have caught either.

### Testing

- The two silent-failure layers are now covered end to end. `test/panel-state.test.mjs` (7 → 12) pins `snapshotIssues`: each report becomes its own kind with a stable key (asserted to carry no digits, i.e. nothing derived from a list index), a clean snapshot yields nothing at all, and the caller's accumulated warnings add to the snapshot's rather than replacing them — including that an explicitly empty list is respected rather than treated as absent, which is the difference between "nothing to report" and "I did not look". `test/client-bundle.test.mjs` (14 → 18) renders it: a channel whose store could not be read shows as unknown rather than missing, a call with nothing to report renders no list at all, and a warning raised by an earlier credential save survives a later one. `test/locale.test.mjs` (11 → 12) iterates `SETTINGS_WARNING_CODES` and asserts every code has a translation in both languages, so a code cannot ship untranslated. `test/feishu.test.mjs` (39 → 43) covers the onboarding write's outcomes: plain success when the file took the credentials, the not-saved message when no store takes them, success when the credential store saves it instead, and the not-saved message when the store throws too.
- `test/runner.test.mjs` (20 → 33) gained the turn-level cases: the resume-fallback notice — sent once per breakage rather than once per message, and *not* sent for the empty-id first turn — the derived watchdog tick, the heartbeat, and the per-chat override writers on both the update and the create branch. The harness's fake `AgentRegistry` was returning `{ agent, session }` with no `dispose()`, which the real host hangs off every handle, so `AgentRunner.disposeAgent` threw on every session reset path (`/model`, `/reasoning`, `/clear`) and the failure named neither the path nor the cause; it now returns a handle and records its release, and the reset test asserts the release explicitly — an un-released handle is invisible until the host runs out of them.
- `test/unit.test.mjs` (57 → 63) covers `MenuController.openMenu`'s routing for the first time. `menuItems` builds each submenu; `openMenu` is what actually routes a tap, and until now nothing called it. The taps are scripted rather than derived from the rendered options on purpose: a test that can only press buttons the previous render offered could never press a stale one, which is the case worth covering. Both new load-bearing tests are mutation-checked — removing the stale-tap redraw fails exactly that test, and replacing the back-pop's `stack.slice(0, -1)` with `[]` fails exactly that one — so they are demonstrated to fail on a real regression rather than merely to pass. The existing live-plane assertion gained the guard the string above needed: it now checks that both languages name `cordis.patch.yml` and that neither still names `settings.yaml`, since the fault was a string that was *present* and wrong rather than missing. 408 → 441 tests, all passing.

### Documentation

- **Both package READMEs' resume-failure troubleshooting row now names the chat notice**, since the log line it documented was the only report and a user reading the table had no way to know the chat would also say so. Both also gain the reason the searchability of that row matters.
- **A note on the channel list being pinned once you press Save.** The host's `replace()` writes a complete declared section and resets a declared field an update omits to its inherited value, so pressing Save pins `channels` to the list as it stood at that moment — **there is no way to unpin it from the pane**, and a channel added by a future release will not be enabled for a user who has saved at least once. Documented rather than fixed: a diff-against-resolved payload would be destructive on this seam, since the resolved section is what the pane is reading, so the honest move is to say what Save does.
- **The six settings-pane screenshots were re-captured against `0.2.0-rc.2`.** The existing set was taken on `0.1.5-rc.2`, and the host's own chrome had moved on: the nav entry beside `dsh-connect` now reads 「内置插件」/「Built-in plugins」 rather than 「插件」/「Plugins」, and the panel header gained an 「打开配置文件」/「Open configuration file」 button. A screenshot is documentation, and one showing a shell that no longer exists understates the changes for anyone upgrading. Captured from the same clean-room profile as before — the plugin linked to this working tree, every credential in it a fake placeholder (`cli_a1b2c3d4e5f60789` / `fake…1e00` in the shots) — so what is in frame is the code in this release.

## [0.9.2] - 2026-10-02

The DSH 0.2 line. The published `0.9.0` — and the in-repo `0.9.1`, which was committed but never published — were built against `0.1.5-rc.2`, and DSH refuses to load them on `0.2.0-rc.2` — the compatibility gate read our pinned `^0.1.5-rc.2`, which is `>=0.1.5-rc.2 <0.2.0` and therefore excludes the new host by construction, and told the user to install a compatible version instead. The range is now in step. The same upgrade also moved where per-plugin settings live, which is what most of this release is about: DSH 0.2 no longer reads plugin settings out of `$DSH_HOME/settings.yaml`, and the host's own migration drops the old `dsh-connect:` section with a warning, so without the import below an upgrading user's pane choices would silently revert to defaults the first time they opened the pane.

### Changed (breaking)

- **Requires DSH `0.2.0-rc.2`.** The `peerDependencies` / `devDependencies` range for `@deepseek-ai/dsh-agent`, `dsh-llm` and `dsh-session` moved from `^0.1.5-rc.2` to `^0.2.0-rc.2`. This is not cosmetic: the host evaluates `semver.satisfies(runtimeVersion, requirement, {includePrerelease:true})` before loading a plugin, so the old range fails on `0.2.0-rc.2` and the plugin is refused with "may cause crashes or data loss". Keep the range in step with the host on every DSH upgrade — the failure mode of a stale range is a refused install, not a redirected import.

### Changed

- **The pane writes this plugin's entry in the active profile patch, not `$DSH_HOME/settings.yaml`.** DSH 0.2 keeps per-plugin settings inside the profile's `cordis.patch.yml`, so that is where the pane's `settings` service now resolves and saves the `connect` section — the same file users edit by hand, written atomically under a file lock, comments preserved, hot-reloaded by the loader. Values still resolve in three layers, most specific last: the plugin's schema defaults, then the config the plugin is composed with (its inherited entry), then this plugin's entry in the active profile patch, which holds both hand-written and pane-saved values.

- **A save is projected onto the fields the pane declares, and written whole.** `strip()` deletes only the volatile paths and copies every other key of the raw section verbatim, so an undeclared key — a credential, `settingsStatePath`, something the user added by hand — cannot reach the document even if a caller sends it, and undeclared keys already in the entry survive a pane save. The converse is load-bearing and is why every write sends the complete declared section: the host resets a declared field an update *omits* to its inherited value, so a partial save is a deletion. The pane's editable fields are declared `volatile` in the schema, which makes the running adapters adopt a new value in place on the next turn rather than waiting for a remount.

### Added

- **One-shot import of the pre-0.2 pane settings** (`src/settings/legacy-import.ts`). DSH 0.2's own migration (`SettingsForms.importLegacyDocument()`) renames the document to `settings.yaml.imported` and offers every top-level section to the same write path a pane save uses, which refuses one that names no active configurable entry (`No configurable plugin entry "…"`). This plugin's entry id is `connect`, not `dsh-connect`, so the legacy section is dropped with a warning and every pane-only choice has silently reverted. On the first boot after the upgrade the plugin reads that section from `settings.yaml`, then `settings.yaml.imported`, then the flat fallback `dsh-connect-settings.json`, and writes it into its profile entry. Three properties make it safe unattended: it **merges** rather than replaces (the section given to the host is always complete — what is in force now with the legacy values layered on — because `replace()` resets unlisted fields to their inherited layer, `channels` included, which is how a migration disables every adapter); it is **one-shot**, with a `.dsh-connect-legacy-imported` marker beside the profile entry it writes to recording that it ran, including the benign nothing-to-import case, so a legacy document is never re-applied over later edits; and it **never blocks the load**, degrading a missing parser, an unparseable document or a refused write to one warning line and leaving both files untouched for a retry once the cause is fixed. Secrets cannot travel through it — the legacy section is projected by `sectionOf()`, which keeps declared non-secret keys only.
- **`yaml@^2.8.1` as a dependency**, for that import. It is loaded lazily and its absence is a `parser-missing` skip rather than a failure, so the plugin installs and runs without it.

### Fixed

- **A pane save no longer wipes a channel you had switched off.** The live write is a whole-section `replace()`, and the host resets a declared field an update *omits* to its inherited value — a partial payload is a deletion. The form was seeded from the *enabled* channels only, so every other channel block was left out of the payload, and switching a channel off and then saving — for any reason, even one unrelated to that channel — silently reset its `transport`, `dmMode`, `webhookPort`, `language` and the rest, with nothing in the UI to suggest it. The form now seeds every channel the pane knows; empty blocks are still dropped by the payload builder, so nothing is added to the document.
- **A rotated secret now reaches the running adapters.** Saving credentials wrote the credential store and returned: no config write, so the namespace's `onChange` never fired, and an adapter keeps the secret it was started with. The pane saves credentials as a *second* call after the config, so pasting a new `appSecret` to fix a broken bot was reported as 「已保存」 while the bot stayed broken until the host restarted. The credential write now ends with the same `reconcile()` a config save triggers.
- **A failed state write is reported as a failure, not as success.** `persist()` swallowed the error and `save()` returned a snapshot of the value it had just failed to store — which the pane renders as 「已保存」, with the setting gone at the next restart. On the JSON fallback plane the failure now surfaces as `save-failed`, a code the RPC already forwards verbatim, so the pane's own error state shows instead.
- **A legacy document that cannot be read no longer ends the migration.** "Not there" and "could not be read" were the same outcome, so a single `EACCES` — or a `settings.yaml` that is accidentally a directory — marked the migration done: silently, permanently, against a document that may have held the user's pane settings. The unreadable case is now its own outcome, and the one case that is not final: nothing is imported, **nothing is marked**, one warning names the path and the reason, and the next start tries again.
- **`DSH_HOME=~/.dsh` is expanded rather than read as a literal `~`.** A natural thing to write in a shell profile and a perfectly literal string to Node: left alone, the migration looked for a directory named `~` under the process cwd, found nothing there, and marked itself done against a home that does not exist. Only a bare `~` and a leading `~/` (or `~\`) are rewritten, so an absolute path is returned exactly as it was given — which is also what keeps `profileContext.home` whole.
- **A YAML parse failure no longer quotes the document into the boot log.** The `yaml` package's error message embeds the offending source *lines*, and the document being parsed is the one holding `appSecret` — so reporting it verbatim copied a credential into a warning. Only the error's `code` and its line and column are reported now, which is everything needed to find the fault in a file the user already has open.
- **A marker that cannot be written is reported instead of swallowed.** A read-only profile directory left no `.dsh-connect-legacy-imported`, so every subsequent boot re-ran the whole migration and layered the legacy values back over whatever the user had changed in the pane since — with no visible reason for the settings reverting. The failure now warns, and says which of the two consequences it has. A marker that exists but cannot be *read* is likewise treated as "already imported" rather than as absent, which errs toward not re-applying over the user's newer edits.
- **The one-shot marker hangs off the profile entry, not off the state file.** It was named after `${statePath}.legacy-imported`, and that path is the user's to move (`stateDir`, `DSH_CONNECT_STATE_DIR`, `settingsStatePath`) and to delete. Relocate the state directory, or remove one JSON file, and the next boot believed no import had ever run: it re-read the legacy document — the host's own migration keeps the `dsh-connect:` section intact in `settings.yaml.imported` — and layered those values back over every pane edit made since. The marker is now anchored on `profileContext.patchPath`, the profile entry the import writes to; a profile is the one unit that moves exactly when "already imported" stops being true, and per-profile isolation falls out of the same choice, since `$DSH_HOME` is shared by every profile and a marker there would let a second profile skip an import it never ran. A host too old to hand over a profile context still falls back to the state-file suffix, which remains better than no marker at all.
- **Unchecking a channel no longer folds its card shut under the cursor.** The open set was derived from the enabled list on every render, so switching a channel off dropped it from `form.channels`, `initialOpenChannels` was recomputed without it, and the card the user was looking at collapsed. Interacting with an enable box now freezes the current fold first, so an untick closes nothing — in either direction, and whatever the fold was derived from.
- **The save bar sticks to the bottom of the host's scroll region.** `position:sticky` pins to the nearest scrollport only while its containing block is the scrolled box, and the bar was nested inside the defaults card: it could never leave that card, so it pinned to nothing and Save scrolled out of reach with the channel list. It is now the root's last child and carries its own border and radius instead of negative margins borrowed from the card's padding.
- **The focus ring survives a browser without `color-mix()`.** The accent-tinted ring is now preceded by an `rgba()` fallback declaration, so a browser that does not support the function still shows focus instead of silently dropping the whole `box-shadow`.
- **A secret sitting in the config document no longer reaches the browser.** Both read planes drop the per-channel credential keys (`appId`/`appSecret`, `botToken`, the DingTalk pair) before a snapshot crosses the wire — not hypothetical on the live plane, where the resolved section is *allowed* to carry a secret written by hand into the plugin entry (the documented posture, and what the deployed profile does). Credentials stay visible only through the credential store's previews, which are masked host-side. The filter also closes the write path: the form is built from the snapshot and the payload builder re-emits whatever keys it finds there, so an unfiltered read handed the secret back to the server inside the next save. Nothing is removed from a user's document — the filter is one-way, and a hand-written value is left where it was.

### Testing

- `test/settings-namespace.test.mjs` (24) pins the section projection, the three-layer resolution and the write path; `test/legacy-import.test.mjs` (28) pins the merge-not-replace rule, the marker — its benign skip, its anchor precedence, and that it stays put when the user moves the state file — the three source filenames and the flat-vs-document shape of the fallback file — the last one because the fallback store writes its config *flat*, so reading it with the document reader would have marked the migration done and discarded a user's only copy; it also covers the four fixed outcomes below, each of which was a skip that looked like success. `test/client-bundle.test.mjs` (14) renders the pane through a stubbed React and pins the fold sequence against the derived-open-set bug, that the save bar is the root's last child rather than a card's, and that the state-path field appears only on the fallback plane. The fold test is mutation-checked: reverting `setChannels` to the conditional `setOpenOverride` fails exactly that one test and nothing else. 369 → 408 tests, all passing.

## [0.9.1] - 2026-09-23

> **Never published.** This version was committed but no release was cut — no tag, no GitHub Release, no npm publish (`npm view dsh-connect@0.9.1` is a 404, and `latest` stayed at `0.9.0`). Both fixes below therefore first reach users in `0.9.2`.

Two bugs found by using `0.9.0` in a real chat. Both had the same shape: a working path was silently abandoned in favour of one that could not work, and the only symptom on the user's side was nothing at all happening.

### Fixed

- **`ask_user_question` offers reached nobody: the agent raised options and the chat showed none.** The bridge subscribed to a host service (`apiProxy`) that does not exist, so it never registered an answerer at all and every question fell silently through to the host. It now listens on the two waterfalls the host actually dispatches, `user-questions/request` and `approval/request`, and answers with a card (`q:<questionId>:<index>` for a choice, `approval:allow` / `approval:reject` for a tool prompt) or, for a question with no options, by parking on the user's next plain message. The registration is the load-bearing part and is pinned by test: it must be `{ prepend: true }`, because the host's own Web-GUI forwarder is *also* a listener on these events and **parks the waterfall on a promise that never settles while no browser tab is connected** — a listener registered after it is never called, which is exactly what "the agent gave me options and Feishu showed nothing" looked like from the chat. A session claimed for the chat but not presentable as a card is declined (`supportsChoices: false`, i.e. the web mirror, whose `promptChoice` resolves `undefined` immediately and would spin the re-present loop forever), as is an already-cancelled request, an unowned session, a second concurrent request in one chat, and an undeliverable card — each of which falls through to `next()` so the host's normal path still runs, and each of which releases the chat rather than leaving a pending entry that would swallow the user's next message. `test/interaction.test.mjs` covers the flow end to end (16 tests, mutation-checked: dropping `{ prepend: true }` and dropping the empty-card-id guard each fail exactly one).
- **"此操作已失效" on a card tap that was perfectly valid.** The menu's card action handler treated any tap with no pending prompt as stale, but the tap that lands in the window where a card is being *redrawn* has no pending prompt either: the first tap resolves the current question and the bridge immediately re-presents the same card for the next one, so a second tap arriving in that gap — or a double tap on the last option — was answered with a stale-action notice instead of being ignored. The adapter now holds a 5 s absorption window per card while it is re-drawn and swallows taps inside it, and `bind()` cancels the window so the next step's first tap is taken normally. `test/feishu.test.mjs` covers the swallowed tap, the cancelled window, and the two `promptChoice` teardown paths (a pre-aborted signal must not present a card at all; an abort mid-wait must resolve and retire the card). 349 → 369 tests, all passing.

### Documentation

- **Both package READMEs gained a "questions and approvals in a conversation" section**, because the feature above had never been documented at all — the failure it fixes ("the agent offered options and nothing appeared") was, from the user's side, indistinguishable from the feature not existing. It covers what each kind of prompt looks like in the chat, that an approval accepts only a tap, that one chat holds one card at a time, and what the stale-action notice does and does not mean. The two troubleshooting rows that pointed at "menu cards don't update / expire" now carry the two 0.9.1 fixes as well.
- **The root READMEs' "How it works" section described a mechanism that does not exist**, and had since before `0.9.0`: it credited the bridge to an in-process client of a host `ctx.apiProxy` service, subscribing to the Web GUI's mux stream and responding through `apiProxy.respond`. No such service exists — that imaginary design *is* the bug fixed above, and a reader debugging "the options never showed up" would have been led straight to it. The section now describes the two waterfalls, the `{ prepend: true }` requirement and why it is not optional, and what happens to a request the bridge declines.

## [0.9.0] - 2026-09-21

Audit of the whole plugin against DSH `0.1.5-rc.2` — it had been built for the `0.1.0-rc.6` line — and the repair that came out of it. The headline is that **saving in the Web settings pane now survives a restart**: the pane's authoritative store is the `dsh-connect` section of `$DSH_HOME/settings.yaml`, written through DSH's own first-party settings seam (hot-reloaded, atomic, file-locked, comment-preserving) instead of a private JSON file nobody read back.

### Changed (breaking)

- **Requires DSH `0.1.5-rc.2`.** The `peerDependencies` / `devDependencies` range for `@deepseek-ai/dsh-agent`, `dsh-llm` and `dsh-session` moved from `^0.1.0-rc.6` to `^0.1.5-rc.2`. The old range no longer overlapped the host, which is exactly why the drift below stayed silent; keep the range in step with the host on every DSH upgrade.
- **`dsh-connect` settings are user-editable.** The pane and the official Plugins page now render and write the same namespace. The plugin's existing `cordis.patch.yml` config is *not* discarded — it is registered as the base layer, and values resolve schema defaults → plugin config → `$DSH_HOME/settings.yaml`. A hand-edited `settings.yaml` takes effect without a restart.

### Changed

- **Reversal: the pane's credential inputs are no longer write-only.** They were made presence-only deliberately, and for a real reason — echoing an `appSecret` back into the pane put it in browser state and in every screenshot of the settings page. But a user who cannot see what is stored cannot confirm they filled it in correctly, so the preview is back: generated on the **host**, already masked, and rendered as read-only text *beside* the input rather than as the input's value. The inputs still start blank, blank still means "leave the stored value alone", and `buildCredentialSaves` still reads only what was typed — a mask can never be written back as a credential. The line that mattered is unchanged: a browser tab still never holds a usable secret. (Superseded by the `secretPreviews` field below; presence-only `secrets` is retained alongside it.)

- **The settings pane is a channel tab strip over collapsible cards.** Four channels rendered at once came to roughly 2000px of content inside a 690px scroll region — three screens of scrolling to reach Save, with every field laid out whether or not its channel was enabled. Each channel is now a card headed by a button (`aria-expanded`), its low-frequency fields (`webhookPort`, `webhookPath`, `pollingTimeoutSeconds`, `baseUrl`, `defaultAt`, `pollIntervalMs`) sit behind a second-level 高级 fold, and Save/status are pinned to the bottom of the scroll region. A channel's tab opens that card and scrolls it into view *without* closing the others — several open at once is a legitimate state, which is also why the strip is a `nav` of `button`s rather than `role=tablist`: tab semantics would have to name one selected tab and there isn't one. Default is exactly the enabled channels, or the first when none are; ticking a channel's enable box opens it too. Collapsing **unmounts** the body rather than hiding it, which is safe because an unsaved secret typed into a card lives in the parent's state. The rules live in `client/panel-state.mjs`, a pure module, so "which cards start open" and "which fields are advanced" are testable without React.

### Added

- **The settings pane shows what you already configured.** Every credential field carries a read-only `当前值：…` line (`未配置` when nothing is stored) so a value can be confirmed without retyping it, and every channel, config field, secret field and `select` option carries a one-line explanation of what it does. The masking policy lives in one shared table, `src/settings/secret-disclosure.ts`, consumed by both the host's masking and the pane's choice between a `password` and a `text` input, so the two cannot drift apart. `appId` / `clientId` are identifiers rather than authenticators and are shown in full; `appSecret` / `clientSecret` / `botToken` / `secret` show head and tail with the middle masked (`a1b2…z9y8`), degrading to a fixed `••••••` when the value is too short to survive partial disclosure; a DingTalk `webhookUrl` is URL-aware — origin, path and parameter *names* survive, and only the token's middle is masked, because masking the whole string (`https…bcde`) would confirm nothing.

- **Settings namespace `dsh-connect`** registered via `installSection` (`src/settings/namespace.ts`), so the plugin still works when the settings service is absent — it falls back to its own composition entry. A malformed user section degrades to the plugin config rather than aborting `apply()`.
- **End-to-end bridge verification** (`test/e2e-bridge.mjs`), which had never been done: inbound message → agent turn → outbound reply, asserted offline against a scripted agent *and* against a live `dsh` host. The live leg self-gates and prints `E2E SKIP` when no launcher is present, so it can never pass by doing nothing.
- **Bridge-core test coverage.** The parts that actually bridge a chat had almost none, while the settings stack was already well covered: `runner.js` 9.1% → 37.9%, `telegram/adapter.js` 32.4% → 91.9%, `feishu/adapter.js` 38.0% → 74.7%, `dingtalk/adapter.js` 23.6% → 79.5%. Overall 247 → 296 tests, all passing.
- **Guards for the three ways the pane above can rot.** `test/secret-disclosure.test.mjs` pins the mask policy (full vs head/tail vs URL-aware, short values, unknown keys). `test/locale.test.mjs` asserts both languages cover the *same* key set — the host resolves a missing key by silently falling back to `en`, which is precisely how a Chinese page ends up half-English with no error anywhere. `test/client-bundle.test.mjs` loads the **built** `client/client.js` through a stub `window.__ModuleLoader__`, renders the pane in Node, and asserts the rendered input `type`s agree with the shared disclosure table, that every field's label and hint actually reach the DOM, and that no mask — or stored secret — is ever placed in an input. It also fails if the bundle was not rebuilt after editing its source. The card fold is pinned separately, in `test/panel-state.test.mjs` — the same render stub can hand the component its state but can never observe what it *initializes* it to (no working `useEffect`, no second render), so the open/advanced rules are asserted as a pure module, including that every `ADVANCED_KEYS` entry is a real field of its own channel (a typo there is invisible at runtime and simply makes a field vanish) and that no credential can ever be folded away. 296 → 344 tests, all passing.

### Fixed

- **Panel saves were silently discarded.** `settingsStatePath` defaulted to `undefined` unless the profile happened to set `stateDir`, so the state file was never written — edit anything, refresh, it was gone. Superseded by the settings namespace above. The four copies of the state-dir default (three literals and a fourth variant that ignored the env var) are now one `resolveStateDir()` helper.
- **The bridge's core turn path was broken on `0.1.5-rc.2`.** `0.1.5-rc.2` deleted the `Session.events` accessor and the `assistant/chunk` event type; the runner (session log + streaming) was migrated to the replacement event API.
- **DingTalk stream credentials were dropped on save.** The pane offered four secret fields but the store only persisted two, and still answered `ok: true` — so `stream.clientId` / `clientSecret` never reached the credential store. Channels are now described by credential *groups* (all-of within a group, any-of across groups); DingTalk's two mutually exclusive transports (webhook push, stream mode) each form a group.
- **A channel with no credentials was reported as unconfigured.** `web` needs no credentials at all, yet the pane showed it as `未配置凭据`. An empty group list is now satisfied by definition.
- **One-click onboarding credentials never reached the credential store.** They were written to `~/.dsh/.dsh-connect/feishu-credentials.json`, so a user who had just scanned the QR code and was talking to the bot still saw `未配置凭据` forever. Onboarding now saves to the credential store, and existing installs are backfilled from the legacy file on boot.
- **Missing credentials could start an interactive QR/link flow during load.** `activateChannels` defaults to *all* channels, so a headless service process with no Feishu credentials would begin a scan-to-authorize flow nobody could answer. It is now gated on `onboarding !== false` and an interactive `stdout`, and otherwise logs a pointer to the settings pane.
- **Dead reference in `dsh.client.inject`** — `@deepseek-ai/dsh-client-runtime` is not in the `0.1.5-rc.2` bundle.
- **Telegram: `replyRef` carried the replied-to message's id instead of the message's own.** It was set to `reply_to_message.message_id`, so ordinary messages had no `replyRef` at all and every one of them shared the core's "no id" dedup slot, while two different replies to the same bot message collapsed onto one key and the second was silently dropped. Since the outbound path echoes `replyRef` back as `reply_to_message_id`, the bot also threaded its answer under the wrong message. `replyRef` is now this message's own id, matching every other channel; the group @-mention gate is unaffected (it reads `reply_to_message` directly).
- **The Web settings pane mixed Chinese and English.** Channel names, field labels (`transport`, `requireMention`, …), `select` option values, the `(default)` placeholder and the raw status ids (`idle`, `saving`) were hardcoded, so they stayed English inside a Chinese page. Every string now resolves through `client/locale.mjs`, with a fallback wrapper so a missing key shows a readable label instead of the key itself (`f.dmMode`).
- **DingTalk: non-text payloads ran an empty agent turn.** `normalizeBotMessage` promised `undefined` for payloads with no usable text body but never checked, so a picture, file, sticker or recall notice normalized to `text: ""` — a wasted model call and a reply to a message the user never sent. It now drops whitespace-only bodies, as the doc already claimed.
- **Feishu: thread messages in an allowlisted chat were dropped.** With `threadIsolation`, the adapter scoped the chat key to `chatId:thread=<rootId>` while `allowChats` is documented in plain chat ids, so an allowlisted chat's threads passed the adapter's pre-download check and were then rejected by the core — with no log, which is what made it look like the bot ignoring the user. The thread-key codec now lives in one module (`src/chat-key.ts`) that both the core gate and the adapter's pre-check consume, so the two can no longer drift; `allowChats` matches on the base chat id.
- **An inbound message dropped by the allowlist is now logged** (`connect: inbound dropped by allowlist (…)`). Behavior addition beyond the fixes above: a gate that disagrees with an adapter's own pre-check previously showed up only as silence.
- **The pane's inputs were ~20px wider than the grid track they sat in, and printed over the neighbouring column's label and hint.** This — not the height — is what "很多文字跟窗口重叠" was. The bundle contained no `box-sizing` declaration at all, and the host shell ships no global `*{box-sizing:border-box}` reset (the whole shell has 11 class-scoped declarations and none of them reach us), so `.ds-input{width:100%;padding:0 9px;border:1px}` computed to the track *plus* 18px of padding *plus* 2px of border, while `.ds-field`'s `min-width:0` kept the track itself from growing: the excess had nowhere to go but on top of the next column. `<fieldset class="ds-channel">` compounded it with the UA's `min-width:min-content`. The pane now carries a scoped box-sizing reset and a `<div>` where the fieldset was, and `test/client-bundle.test.mjs` fails if either comes back.
- **The pane followed the OS colour scheme instead of the host's theme.** An `@media(prefers-color-scheme:dark)` block redefined the whole palette unconditionally, so a dark OS with a light DSH — or the reverse — put a pane that disagreed with the shell around it on screen. The block is gone; every colour now resolves from the host's own tokens (`--dsw-alias-label-primary`, `--dsw-alias-label-tertiary`, `--dsw-alias-border-l2`, `--dsw-alias-button-primary-fill`) with our previous values kept as the fallback so a bare environment still renders. The accent is `--dsw-alias-state-business-primary` (`#4176e6` light / `#679efe` dark) — *not* `--dsw-alias-brand-primary`, which is near-black in light and near-white in dark and would have quietly made the pane monochrome.
- **A stale agent-preset id made the bot reply with nothing but a raw host error, once per message.** `composeSetup` resolved its preset by id and let the throw escape — and it does so *before* an agent exists, so with `agent-presets.default: code` in `$DSH_HOME/settings.yaml` (an id no build ships) every turn of every bound chat died at the same line, the user got the unedited `agent-presets: preset "code" not found (available: standard, ptc, minimal, cordis)` back, and no session log was written to say why: the symptom was "给飞书发信息没有反应". Resolution is now best-effort and logs both halves of the decision — the configured id is tried, then `standard` (or the roster's first mountable row, from `agentPresets.list()`), and when neither composes, the agent is built without a preset, the shape a host with no `agentPresets` service already produced, so the turn still runs. A preset that resolves but reports itself `broken` is refused at composition rather than passed to `mount`, where the host's own mounting paths refuse it. Five tests (`test/runner.test.mjs`, group G) pin the recovery, the diagnostic, and — the guard against the obvious way this feature could go wrong — that a *healthy* resolution still mounts exactly the configured preset and logs nothing. 344 → 349 tests, all passing.

### Documentation

- **All four READMEs brought level with the code above**, plus the option reference, the publishing guide and the consolidation design notes. The corrections that mattered: `agentPreset` still described as a preset you set and get, with no mention of the degradation added in this release; the streaming section still crediting the `assistant/chunk` session event that `0.1.5-rc.2` deleted; the one-click onboarding note still sending credentials to `feishu-credentials.json`; and two links in the package README that pointed outside the published tarball (`docs/feishu-setup.md`, `../../examples/profile-cordis.patch.yml`) and therefore 404'd on npm. All four also claimed `notifyLevel` defaulted to `important`; it has defaulted to `result` since `fe4d051` (`v0.7.1`), which the changelog never recorded, so the claim had been copied forward ever since. The rule now applied throughout: links *inside* the package stay relative, links that escape it are absolute `blob/main` URLs.
- **The rest of `docs/` swept against the same code**, since several pages had been written before the consolidation and still described it in the future tense or by the deleted package names. The load-bearing corrections: `notifyLevel`'s type in `config-reference.md` (`"none"|"progress"|"result"` — a union the schema has never had) and `settingsStatePath` described as the store rather than the fallback; `all-in-one-and-web-settings.md` summing the old `packages/connect-all/` tallies (37/40/44/50/52/56/57) toward a total, which double-counts under one package — the current figure is 349; `QUICKSTART` hardcoding one developer's checkout path; `feishu-setup` still pointing onboarding at `feishu-credentials.json`; and `SHARED_WORKSPACE_SETUP` claiming all channels read config from `dsh.shared.config.json`, which only supplies workspace/stateDir/language/autoMirror defaults. Sections that describe the pre-consolidation world are now labelled as historical rather than rewritten — they are the record of why the merge happened.
- **Screenshots of the settings pane ship in the package** (`docs/images/`, six captures: pane overview, an open 高级 fold, and the shared-defaults card, each in `zh` and `en`) and are embedded in the READMEs, so the layout described above can be seen rather than only read. They are taken from a throwaway profile holding nothing but placeholder credentials — which is also the only kind of capture that can exist, since the host masks values before they reach the browser.

## [0.8.1] - 2026-09-03

### Fixed

- **Backward-compat: config-file credentials now show in the settings pane** (`dsh-connect`). On boot, `apply()` migrates channel secrets that already live in the config (e.g. a pre-consolidation `feishu.appId`/`appSecret` in `cordis.patch.yml`) into the credential store — only for refs the store doesn't already hold, so pane-saved credentials always win. The pane then reports those channels as `已配置` instead of `未配置凭据`, and prefills each channel's secret fields from the store (non-confidential ids like `appId` shown plain; real secrets masked). Secret values are never written into `dsh-connect-settings.json`. (`migrateConfigSecrets` in `src/index.ts`, `extractConfigSecrets` in `src/settings/channels.ts`, `SettingsSnapshot.secrets`, `client/settings-client.mjs`.)

## [0.8.0] - 2026-08-31

### Changed (breaking)

- **`dsh-connect` is now the single all-in-one plugin.** The former split packages — `dsh-connect-feishu`, `dsh-connect-telegram`, `dsh-connect-dingtalk`, `dsh-connect-web` and the `dsh-connect-all` bundle — were deleted. Everything (core `connect` service, all four channel adapters, and the web-settings stack) now ships in the one `dsh-connect` package. Install once:
  ```sh
  dsh plugin --profile web add dsh-connect
  ```
- **One config block**: all settings live under a single `dsh-connect` entry with a `channels` selector and `channelDefaults`, plus per-channel sub-keys:
  ```yaml
  - id: connect
    name: dsh-connect
    config:
      channels: [feishu, telegram]
      channelDefaults: { language: zh }
      feishu:   { appId: cli_xxxx, appSecret: REPLACE_ME, transport: websocket }
      telegram: { botToken: "123456:ABC" }
      dingtalk: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=xxx", stream: { clientId: "x", clientSecret: "y" } }
      web:      { pollIntervalMs: 1000 }
      settingsStatePath: .dsh-connect/settings.json
  ```
  The former per-plugin blocks (`connect-feishu`, `connect-telegram`, `connect-dingtalk`, `connect-web`) and the `dsh-connect-all` block must be migrated to this shape.
- **Feishu SDK is now a mandatory dependency** (`@larksuiteoapi/node-sdk`) rather than isolated in the Feishu adapter package.
- **Package export surface grows** (`dsh-connect/feishu`, `/telegram`, `/dingtalk`, `/web`, `/settings`) alongside the existing `.` and `/binding`.

### Added

- Web-settings stack absorbed into core: the `/dsh-connect` RPC channel (`settings.get`/`settings.save`/`settings.status` + `credentials.save`), the DSH credential-store adapter, JSON state persistence, and the client settings pane (`client/settings-client.mjs`). Secrets saved from the pane are injected on the next load via `injectSecrets` (dingtalk stream credentials are nested under `stream`).

## [0.7.0] - 2026-08-25

### Added

- **`/remind <time> <text>` — persistent chat-level reminders** (`dsh-connect` core). Schedules a one-shot reminder (`10分钟` / `2h` / `14:30`) stored in `stateDir/reminders.json`; a lightweight 15s loop delivers it when due **without waking the agent or spending model tokens**, and reminders survive process restarts. `/schedule` now lists both agent-level (`schedule` tool) and persistent reminders. (`src/scheduler.ts`, unit-tested.)
- **`/broadcast <text>` — admin broadcast** (`dsh-connect` core). Sends a message to every bound chat across all channels. Gated: requires a non-empty `allowUsers` and a sender listed in it; per-chat delivery failures are skipped and counted. (`service.broadcast`, unit/integration tested.)
- **`/send <path>` — send files from the workspace** (`dsh-connect` core + feishu/telegram). New optional `ChannelAdapter.sendFile` capability: feishu uploads via the SDK's `{ image: { source } }` / `{ file: { source, fileName } }` send shapes (images inline, everything else as an attachment); telegram uses `sendPhoto` / `sendDocument` multipart. `/send` resolves paths against the workdir, enforces a 20MB cap, and falls back to sending the path as text on channels without file support.
- **DingTalk stream mode — bidirectional** (`dsh-connect-dingtalk`). With `stream.clientId` / `stream.clientSecret` set, a ChannelAdapter is registered into `dsh-connect`: STOMP-over-WebSocket gateway client (`src/stomp.ts` codec, `src/stream.ts` client, zero new dependencies, lazy `globalThis.WebSocket` so the module loads on Node 20 and fails only at connect time), group @-mention gating, reply-to-origin via `msgId`, and **numbered-text menus** (answer with a number) as the honest stream-mode equivalent of button cards. Proactive pushes still go through the webhook service. Protocol details (codec, normalization, reply bodies) are unit-tested; the live boundary needs real app credentials.
- **Feishu thread isolation — optional** (`dsh-connect-feishu`). `threadIsolation: true` binds one DSH session per group thread (`chatKey = chatId:thread=<rootId>`) while outbound replies still target the base chat (in-thread via replyRef). Off by default; group behavior unchanged.

### Changed

- DingTalk is now a **two-way channel** in the channel matrix (stream mode), alongside the existing one-way webhook push service.
## [0.6.8] - 2026-08-24

### Fixed

- **mirror-lock queue: duplicate / mis-routed replay after lock release** (`dsh-connect` core). `releaseLock` fired `processQueuedMessages` without awaiting and then wrote a *stale* binding object, resurrecting the cleared queue — the same queued messages could be processed again on the next release. The drain is now awaited and the lock is cleared from a fresh read. Replayed messages also keep their true source `channel` and are routed back through the service into the runner of their own channel (a Web-originated message lands in the web runner, never the releasing feishu runner). The lock state machine (timeout / acquire / release / canWrite) moved into a pure, unit-tested module (`src/mirror-lock.ts`) used by the runner.
- **inbound events re-delivered after a reconnect were queued twice** (feishu). The core now deduplicates inbound messages by `(channel, chatKey, messageId)` with a sliding window (`src/dedup.ts`), so SDK re-delivery of the same event is dropped instead of running the same user message twice. Messages without an id are never deduplicated.

### Changed

- **outbound delivery now retries transient channel failures** (`dsh-connect` core). Every registered adapter's `sendText` / `sendCard` / `promptChoice` / `closeMenu` is wrapped with bounded retry (3 attempts, jittered exponential backoff) so a network blip or a 429/5xx no longer silently drops a user-visible message. `streamText` is deliberately excluded — a partially-streamed reply cannot be resumed. (`src/retry.ts`; unit-tested.)
- **`/export pdf` removed from the user-facing surface**: it was advertised in the command table but unimplemented (it only replied “not supported”). `/export pdf` now falls back to the Markdown export, and the help text, README (zh/en) and `MIRROR_SESSION` docs no longer list a PDF option. A real PDF pipeline can be added later without touching the command surface.
- **new CI workflow** (`.github/workflows/ci.yml`): every push to `main` and every pull request runs build + typecheck + all six test suites on Node 20 and 22, mirroring the publish gate.
## [0.6.7] - 2026-08-24

### Added

- **`/ps <note>` — append to the running task**: while a task is executing, `/ps <note>` (alias `/append`) injects the note into the in-flight task via the agent's steering inbox — a running driver consumes it at its next step boundary, so the user can steer the current task instead of queueing a new turn behind it. When the agent is idle it starts a turn like a normal message. While a task runs, ordinary messages now reply with a hint that `/ps <note>` can append to the running task (or `/stop` to cancel) instead of silently queueing.
- **proactive context-high nudge**: while a turn runs, observed context usage vs. the model window is tracked; when it crosses 75% the user is asked (once per turn) whether to compact now. If the task is still running, compaction is deferred and runs automatically right after the turn ends.

### Fixed

- **dsh refuses to boot (`duplicate loader entry id: connect`)** when this plugin is installed on a fresh profile: since 0.6.4 each package auto-registers via its `dsh.bundle.patch` manifest, so the profile's `cordis.patch.yml` must only *override* their config — re-`insert`ing the same ids (`connect`, `connect-feishu`, …) makes the loader throw `duplicate loader entry id` and dsh aborts at startup. The docs and `examples/profile-cordis.patch.yml` now show the override form (plus `disabled: true` for disabling) instead of `insert` blocks.
- **`config: null` crash on load**: the DSH loader passes `null` (not `undefined`) as plugin config for entries without an explicit config, and does not run schema coercion on this path. `ConnectService` (constructed directly as the default export) and every adapter's `apply()` dereferenced the raw config and threw `Cannot read properties of null (reading 'workDir')`, so even a correct profile failed to boot until `connect` was given a non-null `config`. All five packages now normalize `config ?? {}` before use.

### Changed

- **inbound errors are never silent**: the core no longer fire-and-forgets `handleInbound` — failures are caught and logged as `connect: inbound handling failed` instead of vanishing as unhandled rejections, so adapter-side crashes surface in the `dsh web` log.
- **feishu inbound visibility**: the adapter logs each received message at `info` level (`connect-feishu: received message chat=… sender=… type=… len=…`) before the allowlist gate, so "sent but bot silent" is instantly diagnosable as events-not-arriving vs. events-rejected.

## [0.6.6] - 2026-08-21

### Added

- **feishu history after `/dir`**: the "switch conversation" menu and `/history` now list every session the DSH workspace registry attaches to the current work directory (binding records plus Web-created / older-chat sessions, titles via `sessionQuery.readTitle`, sorted by recency) instead of a bare new-chat entry or a "no active session" error. After switching work directories the historical conversations of that directory are visible and switchable, matching the Web GUI.
- **feishu menu feedback**: every menu button press now answers visibly — switching sessions/work directories, new chat, model and reasoning-effort changes, and placeholder buttons (no history / no models) send a result message (success or why nothing changed) before the menu returns, so users never have to guess whether a press worked. The new-chat confirm prompt reuses the menu card instead of leaving a stale card behind.

### Fixed

- **feishu session titles**: session lists rendered `[object Object]` for Web-created / older-chat sessions because `sessionQuery.readTitle` returns a `SessionTitleSnapshot` object, not the bare title string. The title is now unwrapped (and a plain string still accepted), so work-directory session lists show real titles.
- **feishu menu under rapid taps**: rapid menu navigation (switching workspace, switching conversation, going back…) no longer lands in the wrong menu or freezes. The pending tap listener is registered before the card redraw, so taps arriving mid-redraw are handled instead of dropped as "stale", and a leftover tap from a previous card generation redraws the current menu instead of silently ending the chain.

### Changed

- **terminology**: user-facing copy now consistently says "workspace" (工作区) instead of mixing "work directory" (工作目录) and "workspace" for the same concept — menu labels, `/dir` help, welcome text, status/settings fields and empty-history messages, matching the Web GUI and the `/workspace` `/workspaces` commands. The `/dir` command name and `workDir` config key are unchanged.

## [0.6.5] - 2026-08-20

### Fixed

- **feishu (`dsh-connect-feishu`) hotfix for 0.6.4**: the pre-download allowlist gate crashed on every inbound message — `connect.isChatAllowed` was passed to the adapter as a bare method reference, so invoking it as `this.isChatAllowed(...)` lost the `ConnectService` `this` and threw `Cannot read properties of undefined (reading 'allowUsers')` on every Feishu message (the bot appeared unresponsive). The method is now bound at construction (`connect.isChatAllowed?.bind(connect)`); messages route normally again. **Anyone who installed 0.6.4 must upgrade to 0.6.5.**

## [0.6.4] - 2026-08-20

### Added

- **`dsh.bundle` manifest for `dsh plugin add`** — every package now declares `dsh.bundle.patch` (`./cordis.patch.yml`) in its `package.json` and ships a per-package `cordis.patch.yml` (listed in `files`), so `dsh plugin --profile <name> add dsh-connect dsh-connect-feishu …` installs the packages as proper profile bundle layers (auto-applied, no manual `cordis.patch.yml` editing) instead of plain dependencies.

## [0.6.3] - 2026-08-20

### Fixed

- **core (`dsh-connect`)**:
  - Command dispatch errors no longer crash the host: a failed command's promise rejection is now handled, so an unhandled rejection can't take the process down.
  - `driveAgent`'s streaming error path now guarantees the chunk stream terminates — the streaming card no longer hangs forever, and queues / iterators no longer leak.
  - `buildUserContent` now includes attachments for pure-file messages and vision-capable main models too (previously files were silently dropped).
  - `/new` `/clear` `/switchTo` now reset `webMirrorSessionId` / `lockOwner` and queued messages, so a stale mirror can no longer point at an old session.
  - The mirror mutual-exclusion lock now applies only to the feishu/web channels (telegram/dingtalk are no longer misjudged as web).
  - `getLastTurnInfo` and reminder times use the session language instead of hardcoded `zh-CN`.
  - `/settings` no longer shows the invalid "streaming output / end-of-turn summary" toggles; 10 unused i18n keys removed.
  - The Config schema now explicitly declares `autoMirror`.
- **telegram (`dsh-connect-telegram`)**:
  - Fixed a missing-brace compile error (TS1128).
  - The bot's own messages are now ignored (`is_bot` filter), eliminating the echo loop.
  - `streamText` now accumulates the full text, truncates at 4096 chars and throttles to ~700 ms (previously only deltas were sent, losing content).
  - `getUpdates` long polling is no longer cut short by the 15 s client timeout — the 50 s polling window now actually applies.
  - The offset is confirmed per single update (a failed update no longer loses the whole batch).
  - HTML conversion now fully escapes `& < >` in plain text (previously it could break parse mode).
  - @-mentions now match exactly against the cached `getMe` identity (replying to a normal user no longer misfires).
  - Choice buttons are keyed by the composite `(chatId, optionId)` (concurrent menus no longer overwrite each other).
  - After the timeout, the keyboard is replaced with a "menu expired" notice.
  - Voice / video / audio downloads are now supported.
  - `edited_message` is ignored (streaming edits no longer re-trigger the agent).
  - Unit tests added (escaping / mentions / offset semantics, mocked fetch).
- **feishu (`dsh-connect-feishu`)**:
  - Allowlists can pre-filter before the adapter downloads resources (new public `isChatAllowed` on the connect service).
  - Downloads now have a 20 MB cap and 60 s timeout, async writes, and a 24 h automatic cleanup of the temp dirs.
  - `transport: "webhook"` is truly implemented (bundled `node:http` server + automatic `url_verification` response; `webhookPort` / `webhookPath` configurable).
  - `reject` event logs no longer include PII.
  - Credential files are saved with `chmod 0600`.
  - `stop()` clears choice / stale-reminder timers.
  - Pure functions exported and 8 new unit tests added.
- **dingtalk (`dsh-connect-dingtalk`)**:
  - Network errors and the `errcode 130101` frequency limit now retry with automatic backoff (up to 3 attempts, configurable delay).
  - Markdown bodies are truncated at 20000 chars.
  - `verifyDingtalkSignature` now compares after URL-decoding and enforces a ±5-minute timestamp freshness window (previously encoding mismatches made the signature always fail).
  - Removed the unused `md5Hex` export and 4 dead i18n keys.
  - Tests expanded to 11 (retry / rate-limit / truncation).
- **connect-web / packaging**:
  - `dsh-connect` gained a `"./binding"` export subpath (fixes TS2307 and the runtime `ERR_PACKAGE_PATH_NOT_EXPORTED`).
  - `getBindingStore` now uses the public `bindingStore` getter.
  - Removed the synthetic `[Mirror]` inbound message (it used to create a spurious web runner and burn a real agent turn).
  - `connect-web` tests migrated from vitest to `node:test` and wired into the root `pnpm test`.
  - `dsh-connect-web` `package.json` now ships `README.zh.md` / `README.i18n.yaml` via a `files` field and declares `repository` / `homepage` / `bugs` like the other packages.

### Changed

- **CI / configuration**: `publish.yml` now runs `pnpm build` before test and publish, adds a typecheck step, and publishes the 5 packages serially (connect first). `dsh.shared.config.json` dropped dead keys nobody reads (`bindingsFile` / `sessionStorePath` / `defaultTimeoutMinutes` / `enableLocking`).
- **Documentation sync**: all docs updated to match the code (root README + package READMEs, QUICKSTART, feishu/telegram/dingtalk setup guides, PUBLISHING, MIRROR_SESSION, SHARED_WORKSPACE_SETUP, ENHANCEMENTS_SUMMARY, and a new bilingual `docs/WEB_MIRROR_IMPLEMENTATION.md` + `docs/WEB_MIRROR_IMPLEMENTATION.zh.md`); DingTalk is now honestly described as a one-way push service (no inbound, no automatic lifecycle hooks), the mirror lock is documented as one-sided (Feishu-side only), dead config keys and the broken `$schema` reference were removed, and the publish claims were unified across README and QUICKSTART.

## [0.6.2] - 2026-08-19

### Added

- **Bilingual documentation (zh/en, switchable)**: every user-facing doc now ships as an English + Chinese pair following the official DSH convention — `README.md` / `README.zh.md` (and the `docs/*.md` / `docs/*.zh.md` guides), each with a language-switch link at the top (`English | [中文](…)` ⇄ `[English](…) | 中文`):
  - Root `README.md`, `docs/QUICKSTART.md`, `docs/feishu-setup.md`, `docs/telegram-setup.md`, `docs/dingtalk-setup.md`, `docs/PUBLISHING.md`, `docs/MIRROR_SESSION.md`, `docs/SHARED_WORKSPACE_SETUP.md`, `docs/ENHANCEMENTS_SUMMARY.md`, plus all five package READMEs.
  - `README.i18n.yaml` consistency records (git blob hashes of both sides) for the root and all five packages, matching the official DSH package layout.
  - npm packages now ship `README.zh.md` (and the i18n record) via the `files` field, so the Chinese docs reach npm package pages too.
- `scripts/bump-version.ps1` now updates all five workspace packages (`connect`, `connect-feishu`, `connect-dingtalk`, `connect-telegram`, `connect-web`) instead of two.

## [0.6.1] - 2026-08-18

### Fixed

- **Authorization feedback gap**: tapping an approval card's "同意"/"拒绝" button now immediately shows the result — the card is replaced with a green "✅ 已同意/已拒绝" summary when the decision is accepted, or a "⚠️ 已失效" notice when the request was already handled elsewhere or expired. Previously the card went silent (`void this.respondThen(...)` fire-and-forget), leaving the user unsure whether the tap took effect.
- **Stale-button silence**: tapping a button on an already-handled or expired card (e.g. an old approval card behind new messages) now shows a clear "⚠️ 此操作已失效" message instead of silently ignoring the tap. Applies to Feishu via `cardAction` fallback and to Telegram via `answerCallbackQuery` "expired" toast.
- **Question answer staleness**: when all questions are answered but the host rejects the response (already answered in the Web GUI), the user now sees "⚠️ 此问题已失效" instead of getting no feedback at all.

### Changed

- `presentLoop` callback signature: `onChoice` now receives the card's `messageId` as a second argument and may be **async** — enabling the approval flow to `await respond()` and update the card in place before settling.
- Removed the now-unused `respondThen` helper.

## [0.6.0] - 2026-08-18

### Added

- **`dsh-connect-telegram` — Telegram channel adapter (new package)**. Bidirectional conversation over the official Bot API `getUpdates` long polling (no webhook / public IP needed):
  - Text / markdown replies with HTML parse mode; long answers stream as in-place message edits.
  - Interactive choice prompts (`ask_user_question`, `/menu`) render as inline-keyboard buttons answered via callback queries.
  - Photo / document intake with automatic download into the workdir; group @-mention policy (`requireMention`).
  - Zero runtime HTTP dependency (built on the global `fetch`).
  - Setup guide: `docs/telegram-setup.md`.
- **`dsh-connect-dingtalk` — DingTalk group-webhook push channel (new package)**. One-way notice delivery into a DingTalk group (DingTalk custom robots cannot receive messages):
  - `ctx.dingtalk` Cordis service: `sendMarkdown` / `sendText` with @-mentions by phone / user id / @all.
  - Optional signing secret (`SEC…`); zero runtime HTTP dependency.
  - Setup guide: `docs/dingtalk-setup.md`.
- Workspace now ships 4 packages: `connect`, `connect-feishu`, `connect-telegram`, `connect-dingtalk`; root `pnpm test` covers all of them (29 + 6 + 5 unit tests).

## [0.5.3] - 2026-08-17

### Added

- **First-time welcome card**: the first message in every chat now also sends a one-time welcome card (ability intro + common commands), marked in `bindings.json` so it never repeats.
- **Error classification & actionable advice**: a failed task now shows a suggestion matched to the error — permission problems (Feishu app permissions / DSH sandbox & workdir access), network problems (connection / proxy), model or quota problems (config / `/model` switch), or a generic hint (`/status`, `/stop`).
- **Destructive-action confirmation**: `/clear`, `/new` and the menu's "新建对话" now ask for confirmation first (✅ 确认 / ↩️ 取消), preventing accidental history loss.
- **Progress step counter**: tool-call status lines now include the call number (`🔧 第 2 次工具调用 \`pwsh\``), and the processing acknowledgment reports how many messages are still queued.
- **Group completion @-mention**: in groups, the task-end stats/summary cards now @-mention the requester so the result is noticed.
- New `OutboundTarget.atUsers` (channel adapters may @-mention users on delivery; the Feishu adapter renders it through the SDK's native mentions).

### Changed

- `recordSession` now spreads the existing binding, so per-chat settings (language / notify level / progress interval / welcome marker) survive the first session record.

## [0.5.2] - 2026-08-17

### Added

- **User choices in Feishu**: when the agent calls `ask_user_question` (confirmations, plan reviews, option pickers), an interactive card with buttons now appears right in the chat — no need to open the Web GUI. Answer by tapping a button or by replying with plain text (option number or label; multi-select questions accept `1,3` style lists). The plugin answers through the host api-proxy's own respond path, so the Web GUI stays fully functional and whoever answers first wins.
- **Permission approvals in Feishu**: sandbox/permission requests (`approval/requested`, e.g. tool escalation) render as an allow-once / deny card in the chat, and the user's decision is routed back to the approval service.
- **Processing acknowledgment**: every received message is acknowledged immediately (“✅ 已收到，开始处理” with a preview) before the agent spins up, so the user always knows processing started.
- **Proactive progress watchdog**: if a turn has sent no standalone status for `progressTimeoutMs` (default 5 minutes), a status card reports the latest milestone (thinking / last tool call) instead of leaving the user in silence. New `progressTimeoutMs` config (0 disables) plus a per-chat setting via `/progress` or the settings menu (off / 2 / 5 / 10 / 15 / 30 minutes), persisted in `bindings.json`.
- **Compact feedback**: `/compact` (and the menu action) now announces “🔄 正在压缩上下文…” immediately and reports “✅ 上下文压缩完成” (or the failure) when done.
- **`ask_user_question` visibility**: the tool-call status line now shows the actual question text at every notification level, so a pending choice is never invisible.

### Changed

- `ask_user_question` / approval questions time out per-card but are re-presented in place, so a choice stays answerable for as long as the agent waits.
- Settings overview (`/settings` → 配置总览) now shows the current progress-reminder interval.

## [0.5.1] - 2026-08-16

### Added

- **Notification levels** (`notifyLevel`): streaming replies now follow one of three levels — `full` (stream everything), `important` (key milestones; thinking hint + tool-call status + heartbeat + final answer, no reasoning text), `result` (answer only). Per-chat override via the settings menu or `/notify`; the choice is persisted in `bindings.json` and survives restarts. New `notifyLevel` config key (default `important`).
- **Task-end stats card**: when a task finishes, a card reports the model used, input/output/cached tokens, step count, duration and context usage, and suggests `/compact` when the context is ≥ 75% of the model's window.
- **Web mirror sessions**: `/mirror [--timeout N]` creates (or shows) a mirror of the chat's DSH session in the DSH Web GUI; the mirror shares the same session with mutual-exclusion locking and an optional lock timeout. New `autoMirror` config (default `true`) auto-creates the mirror for every new chat.
- **`streamHeartbeatMs` config**: liveness heartbeat for the streaming card during long silent phases (default 60000 ms; `0` disables it).
- **Feishu file downloads**: the Feishu adapter now downloads attached files/audio/video in addition to images, all via `im.v1.messageResource.get`, with sanitized file names; only stickers remain unsupported.
- **Configurable button grid**: Feishu choice menus now render 2 columns per row by default (was 3), and each menu section can override the column count.
- **Shared config file**: `dsh.shared.config.json` at the project root can supply workspace/state/mirror defaults shared between DSH Web and the connect plugins.
- **`dsh-connect-web` package** (work-in-progress): Web channel adapter that mirrors Feishu conversations to the DSH Web GUI; source committed, not yet published.
- Version bump helper `scripts/bump-version.ps1` and repository rules (`.cursorrules`).

### Changed

- **Default notification level is now `important`** (key milestones) instead of `full`.
- Streaming card layout: blocks, the reasoning phase and the final answer are separated by blank lines, and reasoning text streams live instead of a single static hint; tool calls render as status lines.
- The core README was rewritten to the 9-section spec (Overview / Compatibility / Install & uninstall / Quick start / Configuration / Permissions & data / Troubleshooting / Development / License & security).

### Fixed

- **Model switching from the Web GUI now applies**: the connect runner no longer installs a static model selection that shadowed the api-proxy's per-agent selection, so switching the model in the GUI is actually used by bound sessions instead of silently falling back to the default.
- **Streaming replies no longer concatenate into one unbroken wall of text** (blank-line separation between chunks).
- **Long tasks no longer stall on "Thinking..." for many minutes**: reasoning is streamed live, tool calls emit a status line, a heartbeat keeps the card alive during silent phases, and agent listeners are deduplicated with a `WeakSet` so an externally rebuilt agent can't silently stop streaming.
- Feishu `messageResource.get`-based downloads apply to files/audio/video too (images were already fixed in 0.5.0).

## [0.5.0] - 2026-08-16

> This is the first release since 0.2.0 on npm. The 0.3.0 and 0.4.0 development milestones were never published; their changes are folded into this release.

### Added

- **Configurable message language**: a `language` config (`zh` / `en`, default `zh`) on both `dsh-connect` and `dsh-connect-feishu` switches all user-facing messages (menus, command replies, status lines, image-download errors, help text) between Chinese and English.
- **Menu card polish**: the main menu is now grouped into sections ("Workspace / Session / Task / System") with titles and separators; the "❌ Exit" button uses a red danger style; an operation hint is shown at the card footer; the menu header theme color switched to a more prominent indigo. Choice menus now support optional `sections` (grouping) and `footer` (footer hint) rendering.
- **Smart image handling**: images sent via Feishu are downloaded automatically; if the main model supports vision (`inputModalities` includes image) it sees them directly, otherwise a "vision model" sub-task is invoked to describe the image content, and the description is injected into the main model — so a main model without image support no longer stalls the whole task.
- **Images staged into the workdir**: received images are copied to `<workdir>/.dsh-connect-images/` and the full paths are given to the agent, so even without a vision model the agent can locate the images with its tools.
- **Model capability detection**: automatically probes whether each model supports images; `/settings` model switching shows vision-capable models.
- **`visionModel` config**: `dsh-connect` gains `visionModel: { provider, model }` to pin the vision model for the image sub-task; when unset, the first image-capable model is auto-detected.
- **Adding new models**: models added via the DSH Web model settings are picked up automatically with their capabilities (including vision).
- **Token stats**: `/status` shows the current session's context tokens and session tokens (based on DSH `tokenMeter`).
- **Scheduled reminders**: `/schedule` (`/reminders`) lists scheduled reminders for this session; telling the agent "remind me in 5 minutes…" creates one (requires mounting `@deepseek-ai/dsh-schedule` in the profile).
- **Feishu one-click onboarding**: without `appId`/`appSecret`, the plugin enters onboarding mode and prints an onboarding link (valid ~10 minutes); scan it with Feishu or click and confirm, and the bot app is created automatically with permissions and event subscriptions preset. Credentials are saved for reuse (`$DSH_HOME/.dsh-connect/feishu-credentials.json`).
- READMEs added for both packages (npm package pages no longer show "no README").

### Fixed

- **Fixed Feishu image download failure (HTTP 400)**: images in user messages are now downloaded via the "get resource file from message" endpoint (`im.v1.messageResource.get`, with message_id + type=image). The old code used `im.v1.image.get` (download image), which per the Feishu docs can only download images uploaded by the bot itself, so user-sent images always failed with HTTP 400. The real Feishu error code/detail is also attached to the chat notice to help diagnose permission (`99991672`) and other issues.
- Fixed the missing README on npm package pages.
- Fixed pnpm hardlink EPERM on Windows during dependency reinstall (build environment switched to copy import; runtime unaffected).

## [0.2.0] - 2026-08-15

### Added

- **Interactive menu system** (`/menu`): hierarchical point-and-click (workdir / chats / settings / plugins / compact, …); the same card **updates in place**, supports "🔙 Back" / "❌ Exit", returns to the main menu automatically after an action — continuous operation with no more new cards every time.
- **Settings menu** (`/settings`):
  - Switch model: lists all models registered in DSH, tap to switch (writes to `agentDefaultModel`).
  - Reasoning effort: default / low / medium / high.
  - Notification settings: streaming output, end-of-turn summary toggles.
  - Config overview: model, reasoning effort, preset, workdir, workspaces, allowlists, etc.
- **New commands**: `/plugins` (list plugins), `/workspace <path>` (create a workspace), `/workspaces` (list all workspaces), `/compact` (compact context), `/history [count]` (recent messages), `/goals` (view goals), `/model` (view / switch model).
- Workdir default changed to "the first DSH workspace" (previously the process start directory, which could wrongly point at locations like `C:\Users\...`).
- The model's thinking phase now shows a "🤔 Deep thinking…" hint instead of sitting on the Thinking placeholder for a long time.
- Menu timeout (60 s) now updates the card to "menu expired" instead of silently hanging.
- Feishu buttons unified into a **3-column equal-width grid** (`column_set`), with empty columns auto-padded when there are fewer than 3; button labels are padded with full-width spaces to align by display width (CJK = 2 cells / ASCII = 1, excluding emoji zero-width chars).

### Changed

- All `/` commands are executed locally by the plugin and consume no model tokens.
- Session management upgraded: one chat can hold **multiple conversations** (switch / create / clear), recorded in `bindings.json`, still listable and resumable after restart.

### Fixed

- Fixed menu cards being "usable only once": tapping now updates the same card in place for continuous operation.
- Fixed `cannot get property "agents" without inject` when accessing `ctx.agents` / `ctx.sessions` in Feishu long-connection callbacks (switched to `ctx.get()`).
- Fixed `/dir` not listing DSH's existing workspaces (now wired to `workspaceRegistry`).
- Fixed new session routing not being recorded when agent resume fails.

## [0.1.0] - 2026-08-15

### Added

- First release: connects DeepSeek Harness (DSH) agents to Feishu / Lark.
- Bidirectional message sync: Feishu messages → DSH agent (`agent.followup`), replies stream back to Feishu (typewriter cards).
- Multi-turn context: each Feishu chat is bound to a DSH `Session`, automatically resumed after a process restart.
- Work arrangement: a result-summary card is pushed when a task ends; `ctx.connect.notify()` lets goals/jobs hooks push proactively.
- Basic local commands: `/new` `/clear` `/stop` `/status` `/help`.
- Security: groups require @mention by default, user/chat allowlists, credentials via environment variables or config.
- Layered architecture: `dsh-connect` (channel-agnostic core) + `dsh-connect-feishu` (Feishu adapter), with extension points reserved for DingTalk / WeCom and other channels.