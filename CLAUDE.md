# AI Courtroom

Kahoot-style multiplayer game: two AI agents debate a case sequentially, players bet virtual tokens on a side, send one
suggestion to the agent they backed, and an independent AI judge scores the debate.

## Layout
- `ai-courtroom/`: Next.js 16 (App Router) + TypeScript + Tailwind 4 app. Frontend (Dev 2): `app/play`, `app/projector`,
  `components/`, `lib/api.ts` + `lib/types.ts` + `lib/mock/` + `lib/use*.ts`. Backend (Dev 3, merged from master):
  `app/api/*`, `lib/game`, `lib/supabase`, `lib/ai`, `types/game.ts`, `supabase/` migrations, `scripts/`.
- `ai/`: the AI debate engine (Dev 3 / AI). Frozen; do not modify. Contract: `ai/INTEGRATION.md`, entry `ai/src/index.ts`.

## Frontend (ai-courtroom/)
- `app/play`: player screen (mobile-first). `app/projector`: 16:9 courtroom + host dock overlay. `/` redirects to `/play`.
- `lib/types.ts`: UI types. `JudgeVerdict`/`Scenario`/`Side` are imported type-only from `ai/src/types.ts` via the `@ai/*`
  alias; `PublicArgument` is mirrored from `ai/src/round.ts` (that file pulls in the Anthropic SDK).
- `lib/api.ts`: typed client for every endpoint + **the single backend->UI adapter** (`adaptState`). It imports Dev 3's
  `types/game.ts` (the API contract) and maps it to `lib/types.ts`; components consume `lib/types.ts` exclusively.
  In dev (real mode) it logs a console warning when `/api/state` is missing an expected field.
- `lib/mock/`: mock mode (fixtures + simulated server with skewed clock, shared across tabs via localStorage).
- `lib/useGameState.ts` (2s polling + refetch on focus/online; server clock offset), `useCountdown`, `usePlayer`, `useAdmin`.
- `components/`: shared Kahoot-style UI. Agent A = red + triangle, Agent B = blue + diamond, always with a label.

## Rules
- Server is authoritative: render only from `/api/state`; countdowns use server deadlines + measured offset.
- Never display private AI state, other players' suggestions or ids. Never put secrets in `NEXT_PUBLIC_*`.
- Admin secret: sessionStorage only, sent as `x-admin-secret`. Never in the URL.

## Running
```bash
cd ai-courtroom
npm install
cp .env.example .env         # NEXT_PUBLIC_USE_MOCK=1 (mock is also the default when unset)
npm run dev                  # http://localhost:3000/play  and  /projector
npm run build                # must pass with no type errors
```
Mock mode: open `/play` (phone) and `/projector` in the same browser; they share the mock game. Projector host dock:
press `U` (or click the bottom-right corner), any secret works in mock mode; `H` hides the dock; `?view=display` disables it.
Real backend: in `ai-courtroom/.env` set `NEXT_PUBLIC_USE_MOCK=0`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ADMIN_SECRET` (and `AI_MODE=live` + `ANTHROPIC_API_KEY`
for real model calls). `.env` is the documented env file (Dev 3's `tsx --env-file=.env` scripts read it too).
`NEXT_PUBLIC_*` values are baked in at build time: restart/rebuild after changing them.

Note: `ai-courtroom/AGENTS.md` warns that this Next.js version has breaking changes; check `node_modules/next/dist/docs/`.
