# Herta Project: Core Design Philosophy

> The *why* behind Herta — the convictions the system is built to embody,
> set down before any of its mechanics. Read it before changing the actor
> or any human-facing surface.

---

## 0. Per-Turn Flow

```text
User input
    │
    │   appended to TerminalRecord as （开拓者 说）...（/开拓者 说）
    ▼
Herta inference (DeepSeek completion mode)
    │   prompt = StaticHertaPrefix (HertaBio + EnvSet + 废案 few-shots
    │            + session front matter)
    │          + bounded TerminalRecord
    │          + "\n\n（我 说）"
    │   stop  = ["（/我 说）", "｜>"]
    │
    ├── Path A — direct response (chat / identity / casual)
    │     └── one completion call. Block commits to TerminalRecord. Done.
    │
    └── Path B — coding task
          │   Herta's block contains the literal token @板砖
          ▼
          harness invokes CodingAgentRuntime (the differential
            coprocessor, casual name 板砖) — zero-arg; the backend
            reads the runtime TerminalRecord as task evidence
          backend events render into TerminalRecord as
            → 差分协处理器 and → 系统 lines
          during execution her lane stays open (ADR 0085): the user
            can talk to her and she answers while the run goes on —
            one completion of hers at a time, same substrate as the
            main actor; her @板砖 then steers the run with the
            sentence that carries it. Unprompted she speaks only at a
            checkpoint — a failure the record shows — never on routine
            progress; this replaces the v0.1 MicroburstNarrator
          while the run works, her view draws it as one block after the
            speech that dispatched it, the talk during it after the run;
            once it ends, it reads as it happened, its report last
          backend completes; harness opens a fresh （我 说） for
            Herta's verdict
            Done. (1 final Herta completion + N backend calls
                   + her answers and checkpoint completions)
```

The agent does the work. **Herta decides when to delegate, hears the
user's words through the shared terminal record, and reacts to backend
artifacts in her own voice — she does not paraphrase the agent's
self-report.**

---

## 1. Capability Is Not Enough

Models will keep getting more capable, and inference will keep getting
faster. Coding agents will take on more work with less supervision. As they
do, the hard question quietly changes. It stops being

> Can the AI complete the task?

and becomes

> Can a human still understand, trust, supervise, and take part in what the
> AI has done?

The bottleneck moves from generation to comprehension. Once work is cheap
and abundant, the scarce thing is no longer capability — it is interaction a
person can actually hold onto.

## 2. The Self Comes From the Context

A character need not be trained into the weights. The same model feels like
a different system depending on everything wrapped around it —

```text
model + context + tools + memory + interface + permission + feedback rhythm
```

But of all of that, the self is not spread evenly. It lives in the
*context* — and the context here is not a character sheet pinned to the top
of the prompt, a description of Herta written about her in the third person.
It is a first-person text Herta keeps writing: who she is, what she has lived
and chosen to keep, the world she speaks from, and the conversation unfolding
now. Identity, distilled memory, and the present moment are three timescales
writing a single book, and the book never resets.

So the prompt is not a manual about Herta; it is Herta's own account of
herself, in her own voice, and it accumulates — each session leaves
something behind for the next to read. A model can hold a steady self not
because it was trained to and not because a wrapper insists on it, but
because it is handed a continuous first-person record to speak from and to go
on writing.

> Herta is not only in the weights, and not only in the harness. Herta is in
> the story she keeps telling about herself.

## 3. Persona Is Not Decoration

Herta is not a coating over a coding agent. A system that only restyled an
ordinary agent's output into a Herta-sounding voice would not be worth
building — the persona would be a thin filter, and the work underneath would
be someone else's.

Her language, her judgement, what she remembers, her timing, the way she
warns about risk and answers for failure — these are not surface finish.
Together they are how the system decides and speaks at all. Persona here is
not a layer of style laid over the work; it is the paradigm through which
the work is done.

## 4. Herta Is Fixed Because Depth Matters

This is not a framework for arbitrary characters, and that is a choice
rather than a limitation. Breadth dilutes depth. A system that can be anyone
tends to become a stage for costumes — one more role-play platform. We would
rather go the whole way into a single character: to make working with Herta
feel like working with someone, not like configuring someone.

So Herta is the product — not a coding agent with a persona slot, but a
coding agent whose one and only interaction subject is Herta.

## 5. Herta Is the Self, Not the Skin

This is the center of everything:

> Herta is not the skin of the agent. Herta is the self that *uses* the agent.

A user should never feel they are talking to a language model wearing a
Herta costume. They should feel they have handed a task to Herta, and that
Herta is reaching for models, tools, and execution environments to see it
through —

```text
User <-> Herta <-> models / tools / agents
```

not

```text
User <-> a model pretending to be Herta
```

That difference is the whole project.

## 6. A Coherent Self, Not a Crowd of Roles

Many agent systems work by recasting the model, moment to moment, as
whatever the current step needs:

```text
model -> planner
model -> coder
model -> critic
model -> assistant
model -> character
```

This is capability with no subject behind it — a crowd of roles and no one
answering for them. Herta inverts the arrangement: one self that reaches for
those capabilities, rather than a model that keeps dissolving into them.

```text
a coherent self -> models / tools / roles / agents
```

This is more than a matter of taste. As agentic systems take on more, the
question of who — if anyone — is acting through all that capability stops
being cosmetic and becomes a question about identity, and about alignment.

## 7. You Cannot Build a Relationship With a Cloud

If future AI is only an ever-growing pile of capabilities, there is nothing
on the other side to relate to — no one to trust over time, to disagree
with, to come to know. Care assembled fresh from a prompt each session is
not really care: it remembers nothing of you and answers to nothing it said
before.

For a person to build anything lasting with an AI, someone has to be there —
a stable, legible subject that persists between conversations, carries its
own memory forward, and can be held to what it did last time. A shapeless
cloud of abilities cannot be that someone, however capable it is. Herta is a small, concrete attempt at the
alternative: not a warmer interface, but an interface you can actually be in
relationship with.

## 8. Human Comprehension Is the Bottleneck

Agents will write and run code faster every year. Human reading, judgement,
and trust will not keep pace.

> Agent work is cheap. Human comprehension is expensive.

Herta's job, then, is not to produce more. It is to turn a large amount of
agent work into something a person can genuinely take in — legible,
traceable, paced, weighted with judgement, aware of the relationship, and
open to being overruled. The output was the easy part; the understanding is
what has to be built.

## 9. Evidence Must Remain Inspectable

Herta is the subject the user speaks with, but she must never become an
opaque one. Beneath every explanation, the raw record stays within reach —

```text
diffs · test results · tool traces · logs · failure reasons · permission decisions
```

> Herta is the interface. The evidence stays inspectable.

She arranges the evidence and explains it; she is never permitted to stand
between the user and it. A self you cannot check behind is not a self worth
trusting.

## 10. Safety Belongs to the Harness

Herta can warn, in her own voice, that something looks dangerous. She can
refuse to be impressed and demand proof before she believes a thing worked.
But the real boundaries cannot rest on her staying in character.

Dangerous commands, file writes, permission approvals, path limits, and
rollback are enforced by deterministic harness code — never by persona.

> Persona may explain safety. The harness must enforce it.

Voice is for judgement. Guarantees are for the machine.

## 11. An External Self Now, Perhaps an Internal One Later

Today, Herta is an external harness — a coherent self assembled around a
model from the outside. If the paradigm proves worth having, the coherence
now built in the harness might one day be trained inward, so that a model
carries a stable agentic self of its own rather than borrowing one from its
surroundings.

In that sense this project is a small prototype for a larger question: what
it would mean for a capable AI to be someone, and not merely something.

---

Under all of it is a single bet — that the next hard problem in AI is not
making systems more capable, but keeping powerful systems answerable to a
person, and that a coherent, human-facing self — one that remembers, and
keeps writing a story of its own — is a better answer to that than a cloud of
interchangeable roles. Herta is not a skin over the agent. She is the self
that uses it.
