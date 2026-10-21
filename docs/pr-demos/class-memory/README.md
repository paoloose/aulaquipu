# Class memory: local adapter recording

The screenshot and video replay **the actual terminal output** recorded in `demo.cast`. They show the production memory adapter and pinned SDK talking to a local HTTP fixture. The fixture stores synthetic progress notes; it does not implement Atomic Memory's extraction or contradiction resolution. The recording proves cross-class retrieval, isolation from another student and confirmed deletion of a recalled note.

**This is not a voice session or a screenshot of the student application. LiveKit debugger and cloud simulations remain pending.** No student data, production credentials or external messages were used.

Run from `backend/agents/aulaquipu-tutor`:

```sh
pnpm install --frozen-lockfile
RECORD_MEMORY_DEMO=1 CI=1 TERM=dumb NO_COLOR=1 pnpm exec vitest run \
  src/memory.fixture.test.ts -t 'recorded real memory' \
  --disableConsoleIntercept --reporter=dot --no-color
```

The paced recording test is opt-in so normal tests don't wait through its reading pauses. `transcript.txt` contains the original output; `player.html` replays its original timing without dependencies.
