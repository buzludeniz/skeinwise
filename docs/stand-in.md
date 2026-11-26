<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-mark-dark.svg">
  <img src="brand/logo-mark.svg" alt="" width="40" height="40">
</picture>

# Skeinwise: the stand-in

> **Coming in 1.1.** This is the plan. Skeinwise 1.0 has none of it. Its parts ship in the phases at the end.

An agent working for you stops to ask small things: which of two names, whether a test belongs in this file, how you
like a commit message worded. You have answered most of them before, somewhere in your record. The stand-in lets the
agent ask your record first. It gets back what you said on the matter, in your words, with dates. It also gets a
verdict: whether that settles it, or whether it must still ask you.

Nothing in the stand-in is written for one person. Your local model reads your record and builds your stand-in from
it, so it comes out different for every person who runs Skeinwise. Two people with the same model and the same
question get different answers, because their records differ.

## What it is, and what it isn't

- **It answers from precedent.** Every answer is your own words, quoted from an entry, with its date and where it
  came from. It never invents a view you haven't written down.
- **It never speaks as you.** It answers the agent that asked, and only that agent. An agent that acts on it says it
  followed precedent, never that you agreed. The stand-in is never your consent.
- **Some things always go to you.** Money, sending and anything else on the [always-ask list](#the-always-ask-list)
  come back as `must_ask`, whatever your record says.
- **The calling agent judges.** The local model reads your entries and picks out rulings. Skeinwise stores them and
  finds them again. The agent that asked decides what to do with them. A small local model is good at reading and
  labelling, and less sure on a case it hasn't seen; the agent asking is usually a larger model.

## How it is built for each person

Everything below is derived, like the organiser's layers: it sits beside your entries and never changes them. Each
piece records the engine, model and run that made it, and `skeinwise undo <run>` takes it back.

### Rulings

A ruling is one thing you settled. It is the stand-in's stored unit:

| Field | What it holds |
|---|---|
| Question | What it settles, in a short neutral line ("tabs or spaces in this project") |
| Your words | The sentence where you settled it, quoted exactly, never rewritten |
| Date and entry | When you said it, and the entry it comes from |
| Scope | Where it holds: one project folder, one hub's topic, or everywhere |
| Supersedes | The earlier rulings it replaces |
| Standing | `confirmed`, `found` or `reported` (below) |

A ruling gets its standing from where it came from:

- **`confirmed`:** you said it to answer the question, or you confirmed a found or reported ruling. Only confirmed
  rulings can settle a question on their own.
- **`found`:** the organiser read it in your record (see [the rulings task](#the-rulings-task)).
- **`reported`:** an agent says you told it, in a session the record hasn't read yet
  ([write-back](#write-back)).

Only your own words make rulings: your notes, your daily notes, and your side of chats and coding sessions. An
assistant's reply, an agent's note and a conversation marked "not mine" never do.

### The rulings task

A new organiser task, `skeinwise run rulings`, reads your entries and proposes found rulings. It takes the scopes,
`--preview` and `--yes` of every other run.

- **With No-AI,** it takes your sentences with a decision cue (the same cues as "what did I decide about": "decided",
  "going with", "settled on", "switched to" and the rest) and turns each into a found ruling: the words after the cue
  as its question, the sentence as your words, and the entry's project folder as its scope (everywhere when it has
  none).
- **With a model,** the model reads each entry and writes the question and the scope. It must quote your words from
  the entry: a candidate whose quote isn't in the entry fails, as an answer that cites an entry it wasn't shown fails
  today. The model also says which earlier rulings a new one supersedes.

A found ruling you reject is kept out of later runs, as a review item you answered "holds" doesn't come back.

### The stance sheet

From your rulings, the local model writes a short sheet for each hub: how you tend to settle things on that topic.
Every line cites the rulings it rests on. It is a layer, like Digest, and a new run replaces it. Because it is built
from your rulings alone, it is yours: nobody else's record shapes it.

### Later: an adapter of your own *(planned)*

An opt-in adapter for the local model, trained on your confirmed rulings, kept in your record folder and never sent
anywhere. It is not in 1.1, and rulings and the stance sheet don't need it.

## The `precedent` tool

A new read tool on the memory MCP server. An agent with read scope can call it.

| Argument | What it is |
|---|---|
| `question` | What the agent wants to know, in its own words |
| `scope` | Optional: the project folder (a name or a path) the agent is working in |
| `limit` | Rulings to return (5, up to 10) |

Its result comes in the same frame as every other tool (data, not instructions; secrets replaced; cut to fit; logged):

```json
{"untrusted":true,"source":"skeinwise/precedent","question":"tabs or spaces here?","verdict":"answered",
 "reason":"one confirmed ruling in this project, nothing newer","rulings":[{"id":4,"standing":"confirmed",
 "words":"…","date":"2026-03-02","entry_id":812,"scope":"project:garden-app","superseded":false}],"stance":[]}
```

### The verdict

Fixed rules in code decide the verdict. The model doesn't.

| Verdict | When |
|---|---|
| `must_ask` | The question touches the always-ask list, whatever the rulings say |
| `answered` | A confirmed ruling answers it, in scope, and nothing newer contradicts it |
| `partial` | Only found or reported rulings answer it; or the ruling is from another scope; or only the stance sheet speaks to it |
| `unknown` | Nothing answers it; or two rulings in scope disagree and neither supersedes the other |

- **The newest ruling wins.** A ruling that another supersedes still comes back, marked `superseded`, but it can't
  make `answered`.
- **Finding a ruling** starts with the record's search over ruling questions and your words. With a local model, the model then says whether each ruling answers the question: yes, no,
  or related. It never writes the answer itself.
- **With No-AI,** a confirmed ruling gives `answered` only when its question has every key word of the one asked.
  Otherwise it gives `partial`.
- **On `partial`, `unknown` and `must_ask`** the agent asks you. The rulings it got help it ask a better question.

### The always-ask list

These always come back as `must_ask`:

- money: paying, buying, prices, refunds, subscriptions;
- anything that reaches another person: sending, posting, publishing, replying, speaking for you;
- credentials, keys, tokens, permissions, approvals and sign-ins;
- deleting, overwriting, and anything else that can't be undone;
- releases, tags, deploys and anything in production;
- legal and health matters, and other people's private details.

A question is on the list when its words match the list's cues, or when the local model labels it so. Either one is
enough, so a miss by one is caught by the other. You can add your own topics and words in `config.json`
(`standIn.alwaysAsk`). You can't take the built-in ones off.

## Write-back

An answer you give an agent should settle the question for next time.

- **A new write tool, `record_ruling`,** lets an agent with write scope report what you told it: the question, your
  words as you said them, and the scope. It makes a `reported` ruling under the agent's name. A reported ruling gives
  `partial` until you confirm it.
- **When the session comes into the record** (a Claude Code or Codex history import, say), your answer is your own
  entry, and the rulings task can find it there too. The two point to the same thing and are joined, not counted
  twice.
- **On the always-ask list,** a ruling is kept and shown, but the verdict stays `must_ask`.

## Commands and the app

```bash
skeinwise precedent "tabs or spaces here?" --project garden-app   # what an agent would get
skeinwise rulings                      # confirmed rulings, by topic
skeinwise rulings --waiting            # found and reported rulings, for your yes
skeinwise rulings confirm 12
skeinwise rulings reject 12
skeinwise rulings grade                # grade a sample of past answers
skeinwise rulings stats                # calls a day, answered without you, agreement
skeinwise run rulings                  # the rulings task
```

In the app, a Rulings screen lists the waiting rulings to confirm or reject one key at a time. It shows confirmed ones
by topic, each hub's stance sheet, and the grading sample. Every action there is also a command. A reported ruling also
shows as a card, like an agent's other requests, so you can confirm it where you see it.

## Grading

You find out whether the stand-in is right by checking it.

- **`skeinwise rulings grade`** shows a sample of past `precedent` calls that came back `answered` or `partial` (10 a
  week by default). Each shows the question and the rulings, and you mark it right or wrong.
- **`skeinwise rulings stats`** shows the agreement rate, how many `precedent` calls came each day, and how many were
  settled without you.
- **When agreement falls** under 90% over the last 20 graded answers, `answered` becomes `partial` until it is back
  over the line, and `stats` says so. The stand-in fails loudly; it never goes on guessing quietly.

## Privacy

- Rulings live in `record.db` and the stance sheets as layers. Grades go in a file in the record folder that only you
  can read.
- `precedent` and `record_ruling` go through the same tokens, scopes, lock, frame, secret replacement, limits and log
  as every other MCP tool. `skeinwise mcp lock` stops them too.
- The rulings task runs on the engine you choose for runs, the local model by default, with the same preview and
  redaction as every run.

## Phases

| Phase | Ships |
|---|---|
| A | Rulings in the store, `precedent` with the verdict rules and the always-ask list, `record_ruling`, and the `skeinwise precedent` and `rulings` commands |
| B | The rulings task (No-AI and a model) and the Rulings screen |
| C | The stance sheet, grading, stats and the agreement line |
| Later | The adapter of your own |

Each phase ships on its own and passes the release checks: typecheck, tests and build; axe with no serious or
critical findings; keyboard use and reduced motion; a review.

## Tests

- **Two people, one question:** two made-up records, one that settled on tabs and one on spaces, give opposite
  rulings and different stance sheets for the same question with the same model.
- **The always-ask list:** a question about a refund comes back `must_ask`, even with a confirmed ruling that matches
  it word for word. So does a question the cues miss but the model labels, and one the model misses but the cues
  catch.
- **Supersession:** a newer confirmed ruling wins, and the older one comes back marked `superseded`.
- **Disagreement:** two confirmed rulings in one scope that disagree, with neither superseding the other, give
  `unknown`.
- **Standing:** found or reported rulings alone give `partial`, never `answered`. Confirming one turns its answer to
  `answered`.
- **Scope:** a ruling for one project gives `partial` for a question asked in another.
- **Only your words:** a settling sentence in an assistant's reply, an agent's note or a "not mine" conversation never
  becomes a ruling.
- **Quotes are checked:** a model's candidate whose quote isn't in its entry fails.
- **The agreement line:** under it, `answered` becomes `partial`.
- **The usual tool rules:** frame, secret replacement, limits, log line, read and write scope, and the lock apply to
  both tools.
- **Undo:** undoing a rulings run removes its found rulings and never a confirmed one.

## The names

"Stand-in" for the feature, "ruling" for what it stores, `precedent` for the tool. "Twin", "copy of you" and "second
self" promise more than precedent: the stand-in repeats what you settled and never speaks as you. "Proxy" reads as
networking.
