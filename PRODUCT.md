# claude-lens

register: product

## Product purpose

A local viewer for Claude Code CLI session transcripts (the JSONL files under
`~/.claude/projects/`). It turns a raw machine log into a readable record of
what the agent did: what the user asked, what Claude thought, which tools ran,
what they returned, and what it cost in time and tokens.

## Users

Developers who use Claude Code daily. They open claude-lens to review a long
session after the fact: auditing an overnight run, recovering a command, or
sharing what happened with a teammate. They are in reading mode, not building
mode. Often evening, laptop, dim room.

## Tone

Calm, editorial, archival. A transcript is a document you read, so the UI is a
reading surface: generous measure, strong type hierarchy, machinery folded
away until asked for.

## Anti-references

- Terminal cosplay: neon green/blue on pure black, scanlines, fake prompts.
- Chat-app bubbles: this is a record, not a conversation in progress.
- Dashboard slop: hero metrics, identical stat cards, gradient accents.

## Design principles

- Prose is the first-class citizen; tool calls are quiet single rows that
  expand on demand.
- One warm clay accent, reserved for the user's own prompts and selection.
- Warm-tinted neutrals in both themes; system preference decides the default.
- Everything heavy (tool output, thinking, images) renders lazily.
