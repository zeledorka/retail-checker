# AI Courtroom

Kahoot-style multiplayer courtroom game: two AI agents argue a case, players bet on who is right, coach their agent
with one suggestion, and an AI judge delivers the verdict.

- Frontend: [`ai-courtroom/`](ai-courtroom/) (Next.js). See [`CLAUDE.md`](CLAUDE.md) for structure and how to run it.
- AI engine: [`ai/`](ai/), contract in [`ai/INTEGRATION.md`](ai/INTEGRATION.md).

```bash
cd ai-courtroom && npm install && npm run dev
# player:    http://localhost:3000/play
# projector: http://localhost:3000/projector   (press U to unlock host controls in mock mode)
```
