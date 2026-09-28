# Rumple's AstroBit — deploy guide

Asteroids-style Solana game by Rumplebitskin, live at **bit.rumplebitskin.com**.

**Two modes** (Netlify setting `ASTROBIT_MODE`):
- `points` (default, use now): players sign in with their wallet through Rumple's Den, get **5 free plays a day**, and scores
  earn **Rumplebits points** that fill AstroBit's **daily and monthly pots** (paid automatically, shown on rumplebitskin.com).
- `bit` (later, once BIT has a liquidity pool): 1st game free, then **1000 BIT** per game into a weekly pot (90% to the top score).

## What's in here
- `public/index.html` — the game (RumpleBits wheel asteroids, wallet connect, entry payment, Jupiter swap, leaderboard)
- `netlify/functions/api.mjs` — backend: free-game claims, on-chain entry check, scores, weekly pot, RPC proxy, admin view
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
