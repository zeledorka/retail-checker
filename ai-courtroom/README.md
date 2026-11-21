This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Frontend (frontend-UI branch)

Kahoot-style player and projector screens. All backend-to-UI mapping lives in `lib/api.ts` (`adaptState`); screens only
consume the UI types in `lib/types.ts`.

- **`/play`**: player screen (mobile-first). Join with a nickname, bet tokens on Agent A (▲) or Agent B (◆), send one
  suggestion per round to the agent you backed, then see WIN / LOSE, your token change and the verdict. Survives refresh.
- **`/projector`**: 16:9 courtroom display: lobby with join QR code, case reveal, betting, live debate, judging, a
  judge-verdict screen (up to 15 s, shorter if the server's results phase is short), then winner + leaderboard.
  `/` redirects to `/play`.
- **Host dock** (on `/projector`): press `U` (or click the bottom-right corner) and enter `ADMIN_SECRET` to unlock. Start
  round, Advance phase, Run AI step, Cancel + refund, Tick (one autopilot step), Autopilot (ticks every second: runs the
  AI turns and advances phases when their time is up), Reset game, Skip to leaderboard. `H` hides it (autopilot keeps
  running), it fades when idle, and `/projector?view=display` never shows it. The secret is kept in sessionStorage only.
- **Mock mode** (`NEXT_PUBLIC_USE_MOCK=1`, set in `.env.example`; only the exact value `1` enables it): no backend needed. `/play` and `/projector` in the same browser
  share one simulated game; jump between phases with the mock phase switcher in the host dock or the 🧪 button on `/play`.
  Set `NEXT_PUBLIC_USE_MOCK=0` in `ai-courtroom/.env` (copied from `.env.example`, plus the Supabase and admin variables)
  to use the real API; restart `npm run dev` afterwards (`NEXT_PUBLIC_*` values are read at build/start time).
