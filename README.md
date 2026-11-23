# ⚖️ AI Courtroom

A Kahoot-style party game for a room full of phones and one big screen. Two AI agents, **A** and **B**, debate an
ambiguous case, each locked to one interpretation of the evidence. The audience bets tokens on the side they believe,
sends **one clue** to the agent they backed, and an **independent AI judge** (which never sees bets or clues) scores the
debate and picks a winner. Correct bets pay **2× the stake**. A game is **5 rounds**; highest token balance wins.

**Live demo:** <https://ai-courtroom-game.vercel.app>
- [`/projector`](https://ai-courtroom-game.vercel.app/projector): the big screen (case, debate, verdict, leaderboard, join QR)
- [`/play`](https://ai-courtroom-game.vercel.app/play): players' phones (or scan the QR on the projector)

## How to play

1. Open `/play`, pick a nickname (everyone starts with 100 tokens).
2. **BETTING**: read the case, bet any number of your tokens on Agent A or B (one bet per round).
3. **Clue**: from BETTING through DEBATE, send your agent one clue (max 200 characters). It's used in its next turns.
4. Watch the openings and the 8-turn debate, then the judge's verdict: winners get 2× their stake back.

Round flow (≈ 2½ min): Reveal 8s → Betting 20s → Openings 12s → Debate 75s → Judging (~7s) → Results 25s.

## Host controls (`/projector`)

Press **U** (or click the invisible hotspot in the bottom-right corner), enter the admin code **`tandahackathon2026`**,
then open the dock with the **⚙️** button.

| Control | What it does |
|---|---|
| **Start round** | Starts the game (round 1). Also turns on **server-side autopilot**: the game then advances by itself while anyone has `/play` or `/projector` open. |
| **Advance phase** | Moves to the next phase now (e.g. end betting early). |
| **Run AI step** | Makes one AI call for the current phase (opening, turn or judge). |
| **Tick (1 step)** | One autopilot step: an AI call or a phase change if one is due. |
| **Autopilot** (checkbox) | Ticks from this browser tab every second; stops itself after 3 errors. Not needed once server-side autopilot is on. |
| **Cancel + refund** | Cancels the current round and refunds every bet (asks to confirm). |
| **Reset game…** | New game: all players back to 100 tokens, all cases unused (asks to confirm). |
| **Skip to leaderboard ⏭** | On the verdict screen: jump to the winner/leaderboard screen (this screen only). |
| **Lock** | Forget the admin code in this tab. |
| **H** | Hide/show the dock (it stays active; the browser autopilot keeps running). |

The dock fades out after 3 s without mouse movement. Add `?view=display` to the URL for a screen with no host controls at
all. Server autopilot can also be switched with `POST /api/admin/autopilot {"enabled": true|false}` (`x-admin-secret` header).

## Running locally

```bash
cd ai-courtroom
npm install
cp .env.example .env    # fill in Supabase URL/keys + ADMIN_SECRET; AI_MODE=live + ANTHROPIC_API_KEY for real AI
npm run dev             # http://localhost:3000/play and /projector
```

Database (Supabase): run `ai-courtroom/supabase/migrations/0001` → `0008` **in order**, then `supabase/seed.sql`, then
`notify pgrst, 'reload schema';` (SQL Editor, or `npx tsx --env-file=.env scripts/dev/db.ts apply <file>` with
`SUPABASE_DB_URL` set). Without `AI_MODE=live` the AI is mocked (free). `NEXT_PUBLIC_USE_MOCK=1` runs the whole UI
without a backend.

## Tech stack & team

| | |
|---|---|
| **Stack** | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (Postgres, RLS, anonymous auth, Storage) · Anthropic Claude (agents + judge) · OpenRouter (case images) · Vercel |
| **Dev 1: AI agents & judge** | Sequential debate engine and judge in [`ai/`](ai/) (contract: [`ai/INTEGRATION.md`](ai/INTEGRATION.md)) |
| **Dev 2: frontend & cases** | `/play`, `/projector`, components, case generation in [`scenarios/`](scenarios/) |
| **Dev 3: backend & multiplayer** | API routes, game engine, Supabase schema/migrations, autopilot, test scripts (`ai-courtroom/app/api`, `lib/game`, `supabase/`, `scripts/`) |
