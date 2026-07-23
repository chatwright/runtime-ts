# `runtime-ts` — instructions for AI agents and humans

This repository is a **scaffold**: package structure, interfaces, protocol
types and docs only — no deep implementation, no working emulator.

Do not add orchestration, transport or codec implementations here without
first running the dedicated design sessions this scaffold defers to:
research items I-66, I-67 and I-68 in
[`chatwright/chatwright`](https://github.com/chatwright/chatwright)'s
`spec/research/knowledge-platform.md`. A gap here is a reason to open one of
those sessions, not to fill the gap ad hoc.

Typecheck before every push: `npm run typecheck` (or
`tsc --noEmit -p tsconfig.json`).

Local work on this repo is metered — treat `npm install` as expensive; if a
compiler is already available locally, typecheck with that instead of
installing.

Docs in this repository use British English.
