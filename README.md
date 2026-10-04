# Rumple's AstroBit — deploy guide

Asteroids-style Solana game by Rumplebitskin, live at **bit.rumplebitskin.com**.

**Three modes** (Netlify setting `ASTROBIT_MODE`):
- `sol` (default): **0.001 SOL per game** (1st game per wallet is a free practice run). Each entry sends 90% to the pot wallet and
  10% to Rumplebitskin in one transaction. 60% of every entry fills **today's pot**, 30% fills **this month's pot**. The top 3 paid
  scores split each pot 50/30/20, **paid automatically** by `netlify/functions/payout.mjs` (runs hourly, pays a day/month 45 minutes
  after it ends, Central Time). Pots with no paid scores roll over. Each pot is paid at most once.
- `points`: plays through Rumple's Den points (5 free plays a day).
- `bit`: 1000 BIT entry + weekly BIT pot (later, once BIT has a liquidity pool).

### SOL mode settings
| Name | Needed? | What |
|---|---|---|
| `POT_SECRET_KEY` | **Yes, for payouts** (mark as secret) | The pot wallet's private key (Phantom: Settings → Manage accounts → the pot account → Show private key). Payouts stop if it doesn't match `SOL_POT_WALLET`. |
| `SOLANA_RPC` | Recommended | Your Helius mainnet URL. The public RPC rate-limits. |
| `ADMIN_KEY` | Recommended | Long secret. `/api/admin?key=…` shows pots, payouts, carry and flagged scores; `&run=payouts` runs payouts now. |
| `SOL_POT_WALLET` | Optional | Default `PotsipNmNoagBnJLm3KT2ti41tJ8DGZVu3mP1hph6dc` |
| `HOUSE_WALLET` | Optional | Default `RumpP3uH3vgy3nEfdy8CzTSBPP8ydzKgLm24aZANHTG` |
| `SOL_ENTRY_LAMPORTS` | Optional | Default `1000000` (0.001 SOL) |
| `HOUSE_PCT` / `DAILY_PCT` | Optional | Defaults `10` / `60` (monthly gets the rest, 30) |
| `DAILY_SPLIT` / `MONTHLY_SPLIT` | Optional | Default `50,30,20` (must add up to 100) |
| `POT_TIMEZONE` | Optional | Default `America/Chicago` |
| `PAYOUTS` | Optional | `off` pauses automatic payouts (entries still count) |
| `PAYOUT_MAX_SOL` | Optional | Safety cap per payout, default `5`. Bigger pots are held for you to check in /api/admin. |

## What's in here
- `public/index.html` — the game (RumpleBits wheel asteroids, wallet connect, entry payment, Jupiter swap, leaderboard)
- `netlify/functions/api.mjs` — backend: free-game claims, on-chain entry check, scores, pots, RPC proxy, admin view
- `netlify/functions/payout.mjs` — hourly job that pays closed SOL pots
- `netlify/lib/solpot.mjs` — SOL entry checks, pot ledger and payouts
- `netlify.toml`, `package.json` — Netlify config + dependencies (Netlify Blobs is the database; no extra account needed)

## Deploy (functions need Git or the CLI — drag-and-drop won't run the backend)
**Option A — GitHub:** push this folder to a repo → Netlify → Add new site → Import from Git → pick the repo → Deploy.
**Option B — CLI:** `npm i -g netlify-cli` → in this folder `npm install` → `netlify deploy --prod`

## Environment variables (Netlify → Site configuration → Environment variables)
| Name | Needed? | What |
|---|---|---|
| `ASTROBIT_MODE` | Optional | `points` (default) or `bit` |
| `SOLANA_RPC` | Needed for `bit` mode | Your Helius/QuickNode mainnet URL (with key). Public RPC rate-limits. Stays private on the server. |
| `ADMIN_KEY` | Needed for `bit` mode payouts | Any long secret. Open `/api/admin?key=YOUR_KEY` to see the week's scores, entries, pot and winner. Add `&week=2026-W40` for a past week. |
| `POT_WALLET` | Optional | Default `4TxQr8z6voDbqyaBUCGZXk4gYkM8UFdCTCSHaZrPCju4` (rumplebitskin.sol) |
| `ENTRY_FEE` | Optional | Default `1000` RumpleBits |
| `POT_SHARE` | Optional | Default `0.9` (90% to the winner, 10% house) |
| `RUMPLEBIT_MINT` | Optional | Default `CoMnKEneLPXXyCHPWfm4dUvrer4EHJGqhHUSG9CbURTF` |

## Weekly payout (manual)
1. Monday, open `/api/admin?key=…&week=<last week>`.
2. `winner` = top score. Check `secs` (game length) looks right for the score; `flagged` lists scores held as impossible.
3. Send `pot` RumpleBits from the pot wallet to the winner.

## Testing
Open `yoursite/?dev` for a TEST PLAY button (no wallet, nothing saved).

## Notes
- The swap button opens Jupiter with SOL → RumpleBits. It only works once RumpleBits has a liquidity pool Jupiter can route.
- Browser games can be tampered with; the server flags impossible scores, but review the winner before paying.
