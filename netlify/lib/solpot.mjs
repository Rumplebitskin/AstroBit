// Rumple's AstroBit — SOL entry + daily/monthly pots with automatic payouts.
//
// Every paid game sends ENTRY (default 0.001 SOL) in ONE transaction, split two ways:
//   - HOUSE_PCT  (default 10%) -> HOUSE_WALLET   (Rumplebitskin)
//   - the rest   (default 90%) -> SOL_POT_WALLET (pot wallet, used only for prizes)
// The pot share is booked as DAILY_PCT (60% of the entry) to that day's pot and MONTHLY_PCT (30%) to that month's pot.
// Days and months follow POT_TIMEZONE (default America/Chicago). Top 3 paid scores split each pot 50/30/20.
// A scheduled function (payout.mjs) pays closed days/months from the pot wallet, signed with POT_SECRET_KEY.
// Free games are practice only and never win SOL.

import { getStore } from "@netlify/blobs";
import bs58 from "bs58";
import nacl from "tweetnacl";
// No @solana/web3.js here on purpose: it crashes in Netlify Functions (ESM/CommonJS clash in one of its dependencies),
// so payouts build and sign plain Solana transactions by hand with tweetnacl.

export const env = (k, d) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? d);
const int = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; };

const ENTRY = int(env("SOL_ENTRY_LAMPORTS", "1000000"), 1000000);
const HOUSE_PCT = int(env("HOUSE_PCT", "10"), 10);
const DAILY_PCT = int(env("DAILY_PCT", "60"), 60);
const MONTHLY_PCT = 100 - HOUSE_PCT - DAILY_PCT;
const parseSplit = (s, d) => { const a = String(s || "").split(",").map(Number).filter((x) => x > 0); return a.length && a.reduce((x, y) => x + y, 0) === 100 ? a : d; };

export const SOL = {
  potWallet: env("SOL_POT_WALLET", "PotsipNmNoagBnJLm3KT2ti41tJ8DGZVu3mP1hph6dc"),
  houseWallet: env("HOUSE_WALLET", "RumpP3uH3vgy3nEfdy8CzTSBPP8ydzKgLm24aZANHTG"),
  entryLamports: ENTRY,
  houseLamports: Math.floor((ENTRY * HOUSE_PCT) / 100),
  potLamports: ENTRY - Math.floor((ENTRY * HOUSE_PCT) / 100),
  dailyLamports: Math.floor((ENTRY * DAILY_PCT) / 100),
  monthlyLamports: ENTRY - Math.floor((ENTRY * HOUSE_PCT) / 100) - Math.floor((ENTRY * DAILY_PCT) / 100),
  housePct: HOUSE_PCT, dailyPct: DAILY_PCT, monthlyPct: MONTHLY_PCT,
  dailySplit: parseSplit(env("DAILY_SPLIT", "50,30,20"), [50, 30, 20]),
  monthlySplit: parseSplit(env("MONTHLY_SPLIT", "50,30,20"), [50, 30, 20]),
  tz: env("POT_TIMEZONE", "America/Chicago"),
  payoutsOn: env("PAYOUTS", "on") !== "off",
  maxPayoutLamports: Math.floor(Number(env("PAYOUT_MAX_SOL", "5")) * 1e9),
  graceMs: 45 * 60 * 1000,        // wait 45 minutes after a day/month ends before paying it (late games finish)
  maxGameMs: 2 * 60 * 60 * 1000,  // a score must be sent within 2 hours of starting the game
  rentMinLamports: 890880,        // a brand-new wallet can't receive less than this
  rpc: env("SOLANA_RPC", "https://api.mainnet-beta.solana.com"),
};
if (MONTHLY_PCT < 0) throw new Error("HOUSE_PCT + DAILY_PCT must be 100 or less");

const db = () => getStore({ name: "astrobit", consistency: "strong" });
const SYSTEM = "11111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---------- calendar (in POT_TIMEZONE) ----------
const fmtDay = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
export const dayId = (t = Date.now()) => fmtDay(SOL.tz).format(new Date(t));       // "2026-10-04"
export const monthId = (t = Date.now()) => dayId(t).slice(0, 7);                    // "2026-10"
function nextChange(t, fn) {
  const cur = fn(t); let lo = t, hi = t;
  while (fn(hi) === cur) { lo = hi; hi += 3600e3; if (hi - t > 40 * 86400e3) return null; }
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (fn(mid) === cur) lo = mid; else hi = mid; }
  return hi;
}
export const dayEndsAt = (t = Date.now()) => nextChange(t, dayId);
export const monthEndsAt = (t = Date.now()) => { let x = t; let e; for (let i = 0; i < 32; i++) { e = dayEndsAt(x); if (monthId(e) !== monthId(t)) return e; x = e; } return null; };

// ---------- RPC ----------
async function rpc(method, params) {
  const r = await fetch(SOL.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

// ---------- entry check ----------
// Returns null when the transaction is a valid entry from `wallet`, otherwise a short reason.
export async function verifySolEntry(sig, wallet) {
  let tx = null;
  for (let i = 0; i < 8 && !tx; i++) {
    tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tx) return "Transaction not found yet — wait a moment and press RESUME";
  if (tx.meta?.err) return "Transaction failed on-chain";
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 3600) return "Entry transaction is older than 1 hour";
  const keys = tx.transaction.message.accountKeys;
  if (!keys.some((k) => (k.pubkey || k) === wallet && k.signer)) return "Transaction was not signed by this wallet";
  const sent = (to) => tx.transaction.message.instructions
    .filter((ix) => ix.programId === SYSTEM && ix.parsed?.type === "transfer" && ix.parsed.info.source === wallet && ix.parsed.info.destination === to)
    .reduce((s, ix) => s + Number(ix.parsed.info.lamports), 0);
  if (sent(SOL.potWallet) < SOL.potLamports) return "The pot share was not paid";
  if (SOL.houseLamports > 0 && sent(SOL.houseWallet) < SOL.houseLamports) return "The house share was not paid";
  return null;
}

// ---------- ledger ----------
export async function recordEntry(store, { sig, wallet, ticket, time }) {
  const d = dayId(time), m = d.slice(0, 7);
  await store.setJSON(`sol/entry/${d}/${sig}`, { wallet, ticket, time });
  await store.setJSON(`sol/days/${d}`, { day: d });
  await store.setJSON(`sol/months/${m}`, { month: m });
}
export async function recordScore(store, t, row) {
  const d = dayId(t.created), m = d.slice(0, 7);
  await store.setJSON(`sol/score/day/${d}/${t.id}`, row);
  await store.setJSON(`sol/score/month/${m}/${t.id}`, row);
}
const countPrefix = async (store, prefix) => (await store.list({ prefix })).blobs.length;
async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
}
export async function board(store, kind, period) {
  const rows = await readAll(store, `sol/score/${kind}/${period}/`);
  const best = new Map();
  for (const r of rows) { const c = best.get(r.wallet); if (!c || r.score > c.score || (r.score === c.score && r.time < c.time)) best.set(r.wallet, r); }
  return [...best.values()].sort((a, b) => b.score - a.score || a.time - b.time);
}
const getCarry = async (store, kind) => (await store.get(`sol/carry/${kind}`, { type: "json" }))?.lamports || 0;
const setCarry = (store, kind, lamports) => store.setJSON(`sol/carry/${kind}`, { lamports, time: Date.now() });

export async function potState(store, kind, period, includeCarry = true) {
  const entries = await countPrefix(store, kind === "day" ? `sol/entry/${period}/` : `sol/entry/${period}-`);
  const base = entries * (kind === "day" ? SOL.dailyLamports : SOL.monthlyLamports);
  const carry = includeCarry ? await getCarry(store, kind) : 0;
  return { entries, lamports: base + carry, carry };
}

export async function solStatus(store, wallet) {
  const now = Date.now(), d = dayId(now), m = monthId(now);
  const [dp, mp, db1, mb, payouts] = await Promise.all([potState(store, "day", d), potState(store, "month", m), board(store, "day", d), board(store, "month", m), recentPayouts(store, 8)]);
  const wins = (lb, pot, split) => lb.slice(0, 10).map((r, i) => ({ wallet: r.wallet, score: r.score, wave: r.wave, winsLamports: i < split.length ? Math.floor((pot * split[i]) / 100) : 0 }));
  return {
    config: { mode: "sol", entryLamports: SOL.entryLamports, potWallet: SOL.potWallet, houseWallet: SOL.houseWallet, potLamports: SOL.potLamports, houseLamports: SOL.houseLamports,
      housePct: SOL.housePct, dailyPct: SOL.dailyPct, monthlyPct: SOL.monthlyPct, dailySplit: SOL.dailySplit, monthlySplit: SOL.monthlySplit, tz: SOL.tz, payoutsOn: SOL.payoutsOn },
    today: { day: d, endsAt: dayEndsAt(now), entries: dp.entries, potLamports: dp.lamports, leaderboard: wins(db1, dp.lamports, SOL.dailySplit) },
    month: { month: m, endsAt: monthEndsAt(now), entries: mp.entries, potLamports: mp.lamports, leaderboard: wins(mb, mp.lamports, SOL.monthlySplit) },
    payouts,
  };
}
export async function recentPayouts(store, n = 10) {
  const recs = [...(await readAll(store, "sol/payout/day/")), ...(await readAll(store, "sol/payout/month/"))]
    .filter((r) => r.status === "done").sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0));
  return recs.slice(0, n).map((r) => ({ kind: r.kind, period: r.period, sig: r.sig, winners: r.winners.map((w) => ({ wallet: w.wallet, score: w.score, lamports: w.lamports })), paidAt: r.paidAt }));
}

// ---------- payouts ----------
function loadKeypair() {
  const raw = (env("POT_SECRET_KEY", "") || "").trim();
  if (!raw) return null;
  let bytes;
  try { bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw); } catch { throw new Error("POT_SECRET_KEY is not a valid Solana private key"); }
  const kp = bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : bytes.length === 32 ? nacl.sign.keyPair.fromSeed(bytes) : null;
  if (!kp) throw new Error("POT_SECRET_KEY is not a valid Solana private key");
  const address = bs58.encode(kp.publicKey);
  if (address !== SOL.potWallet) throw new Error("POT_SECRET_KEY does not belong to SOL_POT_WALLET — payouts stopped");
  return { secretKey: kp.secretKey, address };
}

// ---- minimal legacy Solana transaction: payer -> several SOL transfers + memo ----
const cu16 = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
function payoutTx(kp, blockhash, transfers, memo) {
  const keys = [kp.address, ...transfers.map((t) => t.to), SYSTEM, MEMO];
  const idx = (k) => keys.indexOf(k);
  const bytes = [1, 0, 2];                                            // 1 signer (payer), 0 read-only signers, 2 read-only programs
  bytes.push(...cu16(keys.length)); keys.forEach((k) => bytes.push(...bs58.decode(k)));
  bytes.push(...bs58.decode(blockhash));
  const ixs = transfers.map((t) => {
    const d = new Uint8Array(12); const v = new DataView(d.buffer); v.setUint32(0, 2, true); v.setBigUint64(4, BigInt(t.lamports), true);
    return { p: idx(SYSTEM), a: [0, idx(t.to)], d: [...d] };
  });
  ixs.push({ p: idx(MEMO), a: [], d: [...new TextEncoder().encode(memo)] });
  bytes.push(...cu16(ixs.length));
  for (const ix of ixs) { bytes.push(ix.p, ...cu16(ix.a.length), ...ix.a, ...cu16(ix.d.length), ...ix.d); }
  const message = Uint8Array.from(bytes);
  const sig = nacl.sign.detached(message, kp.secretKey);
  return { sig: bs58.encode(sig), raw: Uint8Array.from([...cu16(1), ...sig, ...message]) };
}
const rpcConn = {
  getBalance: async (addr) => (await rpc("getBalance", [addr, { commitment: "confirmed" }])).value,
  getLatestBlockhash: async () => (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value,
  getBlockHeight: async () => rpc("getBlockHeight", [{ commitment: "confirmed" }]),
  getSignatureStatus: async (sig, history = false) => (await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: history }])).value[0],
  send: async (raw) => rpc("sendTransaction", [Buffer.from(raw).toString("base64"), { encoding: "base64", skipPreflight: false, maxRetries: 5 }]),
};

async function settle(store, conn, kp, kind, period, log) {
  const key = `sol/payout/${kind}/${period}`;
  let rec = await store.get(key, { type: "json" });
  if (rec && (rec.status === "done" || rec.status === "rolled" || rec.status === "held")) return;

  if (rec && rec.status === "sent") {
    const st = await conn.getSignatureStatus(rec.sig, true);
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      rec.status = "done"; rec.paidAt = Date.now(); await store.setJSON(key, rec); log(`${kind} ${period}: confirmed ${rec.sig}`); return;
    }
    const height = await conn.getBlockHeight();
    if (!st && height <= rec.lastValidBlockHeight) { log(`${kind} ${period}: still waiting for ${rec.sig}`); return; }
    if (st && st.err) log(`${kind} ${period}: payment failed on-chain, retrying`); else log(`${kind} ${period}: payment expired unseen, retrying`);
    // fall through and send again with the same winners and amounts
  }

  if (!rec) {
    const split = kind === "day" ? SOL.dailySplit : SOL.monthlySplit;
    const carry = await getCarry(store, kind);
    const { lamports: base } = await potState(store, kind, period, false);
    const pot = base + carry;
    const lb = await board(store, kind, period);
    let leftover = pot;
    const winners = [];
    for (let i = 0; i < split.length && i < lb.length; i++) {
      const amount = Math.floor((pot * split[i]) / 100);
      if (amount <= 0) continue;
      if (amount < SOL.rentMinLamports) {
        const bal = await conn.getBalance(lb[i].wallet);
        if (bal === 0) { log(`${kind} ${period}: #${i + 1} wallet is empty and prize is too small for a new account — rolled over`); continue; }
      }
      winners.push({ rank: i + 1, wallet: lb[i].wallet, score: lb[i].score, lamports: amount });
      leftover -= amount;
    }
    rec = { kind, period, pot, carryIn: carry, winners, leftover, created: Date.now() };
    // the carry is consumed by this period; whatever isn't paid rolls into the next one
    await setCarry(store, kind, leftover);
    if (!winners.length) { rec.status = "rolled"; await store.setJSON(key, rec); log(`${kind} ${period}: no paid scores, ${pot} lamports rolled over`); return; }
    const total = winners.reduce((s, w) => s + w.lamports, 0);
    if (total > SOL.maxPayoutLamports) { rec.status = "held"; rec.reason = "over PAYOUT_MAX_SOL"; await store.setJSON(key, rec); log(`${kind} ${period}: held, total over the safety cap`); return; }
    await store.setJSON(key, { ...rec, status: "pending" });
  }

  const total = rec.winners.reduce((s, w) => s + w.lamports, 0);
  const bal = await conn.getBalance(kp.address);
  if (bal < total + 20000) { await store.setJSON(key, { ...rec, status: "pending", reason: "pot wallet balance too low" }); log(`${kind} ${period}: pot wallet has ${bal}, needs ${total}`); return; }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = payoutTx(kp, blockhash, rec.winners.map((w) => ({ to: w.wallet, lamports: w.lamports })), `Rumple's AstroBit ${kind === "day" ? "daily" : "monthly"} pot ${period}`);
  const sig = tx.sig;
  rec = { ...rec, status: "sent", sig, lastValidBlockHeight, sentAt: Date.now() };
  await store.setJSON(key, rec);           // saved BEFORE sending, so a crash can never pay twice
  await conn.send(tx.raw);
  log(`${kind} ${period}: sent ${total} lamports to ${rec.winners.length} winner(s), ${sig}`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await conn.getSignatureStatus(sig);
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { rec.status = "done"; rec.paidAt = Date.now(); await store.setJSON(key, rec); log(`${kind} ${period}: confirmed`); return; }
    if (st && st.err) return; // next run retries
  }
}

export async function runPayouts() {
  const out = [];
  const log = (m) => { out.push(m); console.log("[astrobit payouts] " + m); };
  if (!SOL.payoutsOn) { log("PAYOUTS=off, skipping"); return out; }
  const kp = loadKeypair();
  if (!kp) { log("POT_SECRET_KEY not set, skipping"); return out; }
  const conn = rpcConn;
  const store = db();
  const cut = Date.now() - SOL.graceMs;
  const doneDay = dayId(cut), doneMonth = monthId(cut);
  const days = (await store.list({ prefix: "sol/days/" })).blobs.map((b) => b.key.slice(9)).filter((d) => d < doneDay).sort();
  for (const d of days) { try { await settle(store, conn, kp, "day", d, log); } catch (e) { log(`day ${d}: ${e.message}`); } }
  const months = (await store.list({ prefix: "sol/months/" })).blobs.map((b) => b.key.slice(11)).filter((m) => m < doneMonth).sort();
  for (const m of months) { try { await settle(store, conn, kp, "month", m, log); } catch (e) { log(`month ${m}: ${e.message}`); } }
  return out;
}

export async function solAdmin(store) {
  const now = Date.now();
  const [st, dayRecs, monthRecs] = await Promise.all([solStatus(store), readAll(store, "sol/payout/day/"), readAll(store, "sol/payout/month/")]);
  const flagged = await readAll(store, `sol/flag/${dayId(now)}/`);
  return { ...st, carry: { day: await getCarry(store, "day"), month: await getCarry(store, "month") }, payoutRecords: [...dayRecs, ...monthRecs].sort((a, b) => (b.created || 0) - (a.created || 0)), flaggedToday: flagged };
}
export { db as solStore };
