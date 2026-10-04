// Pays AstroBit's closed daily and monthly SOL pots. Runs every hour; does nothing until a day/month has ended
// (plus a 45-minute grace period) and is safe to run repeatedly — each pot is paid at most once.
import { runPayouts } from "../lib/solpot.mjs";

export default async () => {
  try { await runPayouts(); } catch (e) { console.error("[astrobit payouts] " + (e.message || e)); }
};

export const config = { schedule: "@hourly" };
