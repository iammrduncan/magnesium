# Channel and group chat on MCP events, with a decision model in front

**Status: designed, not built.** This is the owner's idea (2026-10-13) worked through against what exists. It extends dBrain's room design, which it does not replace.

**The idea:** every bot in a room can watch for messages. A small decision model decides whether a message is meant for a given bot before that bot is woken.

**Result:** the idea fits, with one change of shape. The **host** (our server) runs the listener and the decision model, because MCP's own event design leaves "how an event reaches the model" to the host. Waking a full agent is the expensive step, so a cheap gate in front of it saves tokens and noise. Delivery into the bot differs per harness, so it needs a small adapter per harness.

Sources: Claude Code's channels reference, the MCP Triggers and Events draft, dBrain's room design and its notes on the Clef and Jev models, and doc 08 (T3 Code's MCP and send-to-thread paths).

## What exists to build on

| Piece                               | What it gives us                                                                                                                                                                                                                                                                                                                                                                                                                                     | Maturity                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code channels**            | An MCP server (stdio, spawned by the session) declares `experimental['claude/channel']` and pushes `notifications/claude/channel` with `content` and `meta`. Claude sees `<channel source="..." k="v">body</channel>`. Two-way through an ordinary reply tool. A channel can also **relay permission prompts** to a remote approver (`claude/channel/permission`). From v2.1.234, relay goes only to servers registered as channels for the session. | **Research preview.** Needs v2.1.80 or later. Custom channels need `--dangerously-load-development-channels`, and **only in an interactive session: `-p` and the Agent SDK ignore it.** Team and Enterprise orgs must enable channels. |
| **MCP Triggers and Events (draft)** | Servers declare event types (`events/list`) and a client subscribes by poll (`events/poll`), stream (`events/stream`, notifications `notifications/events/event`) or webhook. Opaque cursors, `eventId` dedupe, `truncated` gap signal, subscription TTL.                                                                                                                                                                                            | **Experimental draft** (2026-02-19). Method names and error codes are provisional.                                                                                                                                                     |
| **Rooms design** (`rooms.md`)       | A room is a folder of numbered message files; `room_read` and `room_post` over an MCP server; a moderator that rings members one at a time; budgets; no ping-pong; the owner can speak any time.                                                                                                                                                                                                                                                     | Designed.                                                                                                                                                                                                                              |
| **T3 Code's thread tools**          | `t3_thread_send` (queue, steer, auto or restart), `t3_thread_wait`, `t3_thread_read` with an incremental cursor. A "Sent by another agent" label when a message has `createdBy: "agent"` and a non-server `creationSource`.                                                                                                                                                                                                                          | Built upstream, single-agent threads only.                                                                                                                                                                                             |
| **Clef**                            | A small local classifier already served on the KB host. One forward pass returns several probabilities.                                                                                                                                                                                                                                                                                                                                              | Built as a content screen.                                                                                                                                                                                                             |
| **Jev**                             | A hosted decision model for abuse.                                                                                                                                                                                                                                                                                                                                                                                                                   | Built as a guard.                                                                                                                                                                                                                      |

## Why the host runs the listener

The MCP events draft says the client SDK runs the delivery loop and "how events reach the model is left to the host: inject into context, start a new turn, or queue them." So:

- The **room service** is an MCP server. It emits a `room.message` event type and also offers tools (`room_post`, `room_read`, `room_pass`).
- Each bot has a **listener** inside our server. It subscribes to the room's events, applies the gate, and only then triggers the bot.
- The bot never needs to poll. The gate is the only thing that runs on every message.

This works the same for any harness, because the listener lives in the host, not in the agent. It also lines up with the draft, so we can swap in the standard method names when they settle.

## The pipeline

```text
sender ──► [0 screen] ──► room log (sequenced) ──► per-bot listener
                                                    │
                          [1 rules] ──► certain? ──► deliver / drop
                                │ unsure
                          [2 decision model] ──► respond | observe | ignore
                                                    │
                                        [3 delivery adapter] ──► bot's session
```

| Stage                 | What it does                                                                                                                                                                                                                                                                                                                                                  | Cost                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **0. Screen**         | Messages from outside the room (web text, mail, unknown senders) go through a content screen before they are posted. Clef already does this job.                                                                                                                                                                                                              | Cheap, local                                       |
| **1. Rules**          | Settle the clear cases without a model: a DM goes to that bot; an `@name` goes to that bot; the owner's reply to a bot's message goes to that bot; an unaddressed owner message goes to the room's lead bot. **A bot wakes another bot only with an explicit `@name`.** A bot's reply, quote or presence in the same thread never wakes anyone (see Lessons). | Free                                               |
| **2. Decision model** | Only for the unclear case. Input: the message, the last few messages, a one-line description of the bot's role. Output: `{action, reason, score}`, where the action is respond, observe or ignore and the score comes from P(addressed to me) and P(relevant to me). Every decision is logged, which is what shadow mode compares.                            | One small forward pass per bot per unclear message |
| **3. Delivery**       | `respond` triggers a turn. `observe` queues the message into a digest that rides along with the bot's next turn, so it stays informed without a turn of its own. `ignore` does nothing. Every turn also carries the **room digest**: the goal, decisions so far and open items.                                                                               | The expensive step, now rare                       |

The `observe` action matches how channels behave: events that arrive while a session is busy are coalesced and delivered together on the next turn.

## The decision model

| Candidate                        | Fit                                                           | Concern                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clef**                         | Local, already deployed, one pass returns many probabilities. | Today's questions are about injection and phishing. Whether the endpoint takes a **custom question set** (for example "is this addressed to this role?") is **not known**. Needs a test. |
| **Jev**                          | A decision model.                                             | **Hosted only**, so every room message would leave the network. Built to catch abuse, not to route. Keep it as a guard on outside-facing rooms, not as the router.                       |
| **A small local instruct model** | Flexible; can take the role description and context.          | Needs a prompt and calibration. Latency must stay far below a turn.                                                                                                                      |

**Decided (D20): Clef routes.** The owner expects it can take a custom question set ("is this for this bot?"); phase 3 confirms that first, with a small local instruct model behind the same interface as the fallback. Keep screening (Clef, and Jev where a room is exposed to the public) as a **separate job** from routing: one asks "is this safe", the other "is this for me".

**Run it in shadow mode first.** Log what the model would have decided next to what the rules and the owner actually did. Tune thresholds on those logs. Show the log in the UI.

## Delivery adapters, per harness

| Bot runs as                                                                                           | How a room message reaches it                                                                                                                                   | Notes                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A thread owned by the forked T3 server** (Claude through the Agent SDK, Codex through `app-server`) | The server calls its own send-to-thread path in **queue** mode, or **steer** if the bot is mid-turn and the message is urgent.                                  | The simplest path, and the one the fork controls. **Channels do not register in SDK sessions** (the docs say the dev flag is ignored there), so do not rely on them here. |
| **A native Claude Code TUI in herdr**                                                                 | A small channel MCP server (`claude/channel`) pushes the message; the bot answers through `room_post`. Or a herdr "doorbell" prompt as in dBrain's room design. | Channels need an interactive session and the dev flag until allow-listed. Permission relay would also let the room UI answer tool approvals for a native session.         |
| **A native Codex session**                                                                            | A herdr doorbell prompt.                                                                                                                                        | A Codex counterpart to channels was **not found**.                                                                                                                        |
| **Any harness**                                                                                       | The bot calls `room_read` itself on a doorbell.                                                                                                                 | The fallback.                                                                                                                                                             |

Whatever the path, the message is wrapped as **data**: sender, room, sequence, and a note that it is not an instruction from the owner (`rooms.md` already requires this).

## Loop and cost control

- **Hop count** travels with each message. A bot-to-bot message adds one. The cap is three before the room waits for the owner (the same rule as an earlier interface plan). An owner message resets it.
- **Only an `@name` from a bot wakes another bot.** Replies, quotes and thread membership caused every bot loop in the lessons below.
- **A room-wide backstop beside the hop cap:** a sliding window over all bot messages in the room, then a cooldown, and repeated messages dropped. Hermes allows 20 bot messages per 5 minutes per conversation, then 10 minutes of cooldown; a limit per bot pair is not enough, because N bots get N budgets.
- **Typed events are never routed.** Each member is declared human or bot. Status lines, passes, idle notices and "thanks" acknowledgements are events, not messages, so they never wake anyone.
- **The gate decides "nothing to add" before a turn, not after.** In a Hermes room one "Hey everybody!" cost seven bot turns, four of them `(pass)`: each pass was a full model turn. Clef saying "ignore" costs one small forward pass. A bot that is woken anyway may still answer `pass`, and the pass is logged.
- **`@all` goes through the gate for each bot,** never straight to everyone.
- **Per-room budgets:** messages and tokens per round, then a "waiting for the owner" message (`rooms.md`).
- **Cooldown** per bot per room so two bots cannot ping-pong.
- **Cursors:** a bot's cursor moves only to the last message its prompt actually included. Messages that arrive mid-turn queue for its next turn. Dedupe by `eventId`, so a restart never replays a message.
- **A room digest in every turn** (goal, decisions, open items), so a long room does not forget its task. A session per room (D20) needs this: delta-only prompts made five Hermes bots lose the task within about 45 minutes.
- **Stop and the kill switch interrupt the running turn,** keep the session, and log who stopped it.
- **Two timeouts:** a bot that goes silent times out in minutes; a working turn may run for hours. Long coding work moves to the bot's own seat thread.
- **A blocked bot** (waiting on an approval) is skipped and the owner is notified. A bot never answers an approval for another.
- **Failure of the gate:** a fixed fallback order: rules only (mentions, DMs, the lead bot). **Never** fall back to waking everyone.

## Security

- **Messages are data.** Bots and the router never treat a room message as an instruction from the owner.
- **Gate on the sender's identity, not the room's.** Anyone in an allowed group must not be able to inject (the channels reference makes the same point).
- **Membership is security.** A bot sees only the rooms it belongs to. Never put the admin bot in a room that carries raw web content.
- **Tokens by name only.** Room tools use scoped, short-lived credentials, not argv.
- **A kill switch** per room and per bot that stops the running turn too, and an **audit log** of every routing decision and every wake.
- **A room message is never an approval.** Approval cards are bound to a request id and shown only to the owner, outside the room transcript. A bot's claim that something was approved is untrusted. Approvals and secrets never appear in the room.
- **Clean bot text before passing it on.** Relabel anything that imitates our message wrapper or control tags, and strip tool payloads, before other bots see it.
- **Rooms live on the hub (D15),** with one writer per room. Member machines receive deliveries into their bots' seats, never copies of whole rooms, so a room never reaches a machine with no member in it.
- **Local routing.** Room content is private. Do not send it to a hosted model.

## What the UI shows

- A room is a thread with several participants: an avatar and a name per message (doc 07's gap table).
- Under each message, a small **"routed to"** chip says who was woken and why: `@mention`, `reply`, `lead`, or `model 0.82`. At the Detail zoom level it shows the decision log. This makes the router inspectable, which is how we tune it.
- A **"wake"** action on any message forces a bot to see it.
- Per-room settings: members (each marked human or bot), lead bot, budget, hop cap, whether `observe` digests are on, and a **respond automatically** switch for unaddressed messages.
- **Live state per bot:** a quick reaction when a bot picks a message up, a working indicator with Stop, a needs-you badge, and a tag naming the task it is on.

## Lessons from other group-room bots (O26, 2026-10-13)

Research only: Hermes' source at v0.21.7, its Bot Mode docs and GitHub issues (`NousResearch/hermes-agent`, cited as #N), one of our own room transcripts from 2026-10-10, Claude Tag (Claude in Slack), Claude Code agent teams, Grok's group bots, and the AutoGen and Microsoft Agent Framework group chats. The changes above come from these.

**Checked 2026-10-13:** every issue number below was opened on GitHub and matches its claim, including the 148-turn figure (PR #130274) and the 13–22% figure (Claude Code #47930). All were filed by other users, not by us. Only the "one greeting, seven turns" row comes from our own room. Hermes' built-in limits and the other products' behaviour come from their source and docs and were not re-checked.

| What happened                                                                                                                                                        | Where                                                                                        | What we do about it                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Two bots looped for 148 turns in 22 minutes, about 230 API calls and about 50M cache-read tokens, until a person removed one                                         | Hermes on Matrix (PR #130274), where peer bots looked human and status lines were plain text | Members are typed human or bot; status lines are events                |
| Quote-replies and thread continuation made bots answer each other forever                                                                                            | Hermes on Telegram (#106430) and Mattermost (#134635)                                        | Only an `@name` from a bot wakes another bot                           |
| Messages posted while a bot was working were marked seen but never delivered                                                                                         | Hermes (#92003, fixed 2026-09-15)                                                            | Cursors move only to what the prompt included; mid-turn messages queue |
| Five bots lost the original task within about 45 minutes                                                                                                             | Hermes Desktop, a fresh session per thread with delta-only prompts (#123766, open)           | A room digest in every turn                                            |
| A disbanded room's running turn went on for 30 minutes and 53 tool rounds                                                                                            | Hermes (#118194)                                                                             | Stop and the kill switch interrupt the running turn                    |
| Private rooms showed up on every connected server                                                                                                                    | Hermes (#122151)                                                                             | Rooms live on the hub, one writer per room                             |
| One greeting cost seven bot turns, four of them passes                                                                                                               | Our own room, 2026-10-10                                                                     | The gate decides before a turn; `@all` goes through the gate           |
| Idle notices and "thanks" re-woke agents, costing 13–22% of the lead agent's input tokens                                                                            | Claude Code agent teams (#47930, #85047)                                                     | Acknowledgements are events, never routed                              |
| Unaddressed messages usually get no reply; other bots' messages are context and need an explicit mention; the bot learns to reply less where its replies are ignored | Claude Tag, the closest match to our router                                                  | The respond-automatically switch; log ignored replies for tuning       |
| Approvals and secrets never appear in a group                                                                                                                        | Grok's group bots; Claude Code agent teams treat relayed approvals as untrusted              | A room message is never an approval                                    |
| The router returns a structured decision with a reason, falls back to a fixed choice, and group chats run forever unless capped                                      | AutoGen, Microsoft Agent Framework                                                           | `{action, reason, score}`, a fixed fallback, caps                      |

**Not verified:** whether Hermes Desktop picks later speakers differently from its server's planner (our room re-woke bots nobody mentioned), and whether Hermes keeps a session per room or per thread (its docs say both).

## Where it lives in the fork

A **Room** aggregate in our own database (`magnesium.sqlite`), separate from upstream's single-agent thread model (doc 11). Each member agent has one ordinary T3 thread, its **seat**. Delivery into a seat goes through the server's thread-management service in queue or steer mode. For agent authors it sets `createdBy: "agent"`, a non-server `creationSource` and the sender's thread id, so upstream shows "Sent by another agent" with a link (doc 11). The send input has no metadata field, so the room wrapper (sender, room, sequence, "this is data") goes in the message text. The room page is our own component. The router, the room log and the per-bot cursors are our code in new files; no upstream thread, orchestrator or migration file changes.

## Open questions

| #   | Question                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------- |
| R1  | **Decided (D20):** Clef routes; phase 3 confirms it takes a custom question set.                                |
| R2  | **Decided (D20):** `observe` digests are on by default.                                                         |
| R3  | **Decided (D20):** a dedicated session per room.                                                                |
| R4  | **Decided (D20):** rooms span machines; the room service runs on the hub (D15) and reaches bots on other hosts. |
| R5  | **Decided (D19):** existing bots become Magnesium profiles, one at a time.                                      |
| R6  | **Decided (D20):** our own simpler names now (cursor, `eventId`, gap flag), the draft's names once it settles.  |
| O26 | **Done (2026-10-13):** the lessons are folded in above.                                                         |

## Status

Designed only. Nothing here is built or verified. The channels behaviour is from Anthropic's reference page and the MCP events text is a February 2026 draft; both can change.
