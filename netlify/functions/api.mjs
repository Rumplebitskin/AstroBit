// Rumple's AstroBit — backend (Netlify Function v2 + Netlify Blobs)
// Routes (all under /api/):
//   GET  status?wallet=       -> config, free-game availability, weekly pot, leaderboard
//   POST claim-free           -> {wallet, message, signature(b64)}  signed "1st game free" claim
//   POST start                -> {wallet, tx}  verifies the 1000 RumpleBits entry on-chain
//   POST score                -> {ticket, score, wave}
//   POST rpc                  -> whitelisted Solana JSON-RPC proxy (keeps your RPC key private)
//   GET  admin?key=&week=     -> full week data for manual payouts (needs ADMIN_KEY env var)

import { getStore } from "@netlify/blobs";
import nacl from "tweetnacl";
import bs58 from "bs58";

const env = (k, d) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? d);

const CFG = {
  mint: env("RUMPLEBIT_MINT", "CoMnKEneLPXXyCHPWfm4dUvrer4EHJGqhHUSG9CbURTF"),
  potWallet: env("POT_WALLET", "4TxQr8z6voDbqyaBUCGZXk4gYkM8UFdCTCSHaZrPCju4"),
  entry: Number(env("ENTRY_FEE", "1000")),          // whole RumpleBits per game
  potShare: Number(env("POT_SHARE", "0.9")),         // share of entries paid to weekly winner
  rpc: env("SOLANA_RPC", "https://api.mainnet-beta.solana.com"),
  symbol: "RumpleBits",
  // "points" (default): AstroBit plays through Rumple's Den points. "bit": 1000 BIT entry + weekly BIT pot.
  mode: env("ASTROBIT_MODE", "points") === "bit" ? "bit" : "points",
};

const RPC_ALLOW = new Set([
  "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts", "getBalance",
  "getTokenAccountsByOwner", "getTokenAccountBalance", "getSignatureStatuses",
  "sendTransaction", "simulateTransaction", "getMinimumBalanceForRentExemption",
]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function weekId(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

function validWallet(w) {
  try { return typeof w === "string" && bs58.decode(w).length === 32; } catch { return false; }
}

async function rpc(method, params) {
  const r = await fetch(CFG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

const store = () => getStore({ name: "astrobit", consistency: "strong" });
const newTicket = () => crypto.randomUUID().replace(/-/g, "");

async function issueTicket(db, wallet, kind, extra = {}) {
  const id = newTicket();
  const t = { id, wallet, kind, week: weekId(), created: Date.now(), used: false, ...extra };
  await db.setJSON(`ticket/${id}`, t);
  return t;
}

async function leaderboard(db, week) {
  const { blobs } = await db.list({ prefix: `score/${week}/` });
  const rows = (await Promise.all(blobs.map(b => db.get(b.key, { type: "json" })))).filter(Boolean);
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.wallet);
    if (!cur || r.score > cur.score) best.set(r.wallet, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.time - b.time);
}

async function potInfo(db, week) {
  const { blobs } = await db.list({ prefix: `entry/${week}/` });
  const entries = blobs.length;
  return { entries, pot: Math.floor(entries * CFG.entry * CFG.potShare) };
}

// ---------- routes ----------

async function status(req) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const db = store();
  const week = weekId();
  const [lb, pot] = await Promise.all([leaderboard(db, week), potInfo(db, week)]);
  let freeAvailable = null;
  if (wallet && validWallet(wallet)) freeAvailable = !(await db.get(`free/${wallet}`));
  return json({
    config: { mode: CFG.mode, mint: CFG.mint, potWallet: CFG.potWallet, entry: CFG.entry, potShare: CFG.potShare, symbol: CFG.symbol },
    week, ...pot, freeAvailable,
    leaderboard: lb.slice(0, 10).map(r => ({ wallet: r.wallet, score: r.score, wave: r.wave, kind: r.kind })),
  });
}

async function claimFree(req) {
  const { wallet, message, signature } = await req.json();
  if (!validWallet(wallet) || typeof message !== "string" || typeof signature !== "string")
    return json({ error: "Bad request" }, 400);
  const m = message.match(/^Rumple's AstroBit\nClaim my 1st game FREE\nWallet: (\w+)\nTime: (\d+)$/);
  if (!m || m[1] !== wallet) return json({ error: "Message does not match wallet" }, 400);
  if (Math.abs(Date.now() - Number(m[2])) > 5 * 60 * 1000) return json({ error: "Signature expired, try again" }, 400);
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    Uint8Array.from(Buffer.from(signature, "base64")),
    bs58.decode(wallet)
  );
  if (!ok) return json({ error: "Signature check failed" }, 401);

  const db = store();
  if (await db.get(`free/${wallet}`)) return json({ error: "Free game already used by this wallet" }, 409);
  const t = await issueTicket(db, wallet, "free");
  await db.setJSON(`free/${wallet}`, { ticket: t.id, time: Date.now() });
  return json({ ticket: t.id, kind: "free" });
}

async function verifyEntryTx(sig, wallet) {
  let tx = null;
  for (let i = 0; i < 8 && !tx; i++) {
    tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) await new Promise(r => setTimeout(r, 1500));
  }
  if (!tx) return "Transaction not found yet — wait a moment and press PLAY again";
  if (tx.meta?.err) return "Transaction failed on-chain";
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 3600) return "Entry transaction is older than 1 hour";
  const signer = tx.transaction.message.accountKeys.some(k => (k.pubkey || k) === wallet && k.signer !== false);
  if (!signer) return "Transaction was not signed by this wallet";

  const delta = owner => {
    const sum = arr => (arr || [])
      .filter(b => b.mint === CFG.mint && b.owner === owner)
      .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  };
  const decimals = (tx.meta.postTokenBalances || []).find(b => b.mint === CFG.mint)?.uiTokenAmount.decimals;
  if (decimals === undefined) return "No RumpleBits transfer in that transaction";
  const need = BigInt(CFG.entry) * 10n ** BigInt(decimals);
  if (-delta(wallet) < need) return `Transaction did not send ${CFG.entry} RumpleBits`;
  if (delta(CFG.potWallet) <= 0n) return "RumpleBits did not reach the pot wallet";
  return null;
}

async function start(req) {
  const { wallet, tx } = await req.json();
  if (!validWallet(wallet) || typeof tx !== "string" || tx.length < 60 || tx.length > 100)
    return json({ error: "Bad request" }, 400);
  const db = store();
  const used = await db.get(`tx/${tx}`, { type: "json" });
  if (used) {
    // Idempotent: page reloaded after paying -> hand back the same unused ticket
    if (used.wallet !== wallet) return json({ error: "Transaction belongs to another wallet" }, 409);
    const t = await db.get(`ticket/${used.ticket}`, { type: "json" });
    if (t && !t.used) return json({ ticket: t.id, kind: "paid", resumed: true });
    return json({ error: "That entry was already played" }, 409);
  }
  const err = await verifyEntryTx(tx, wallet);
  if (err) return json({ error: err }, 400);
  const t = await issueTicket(db, wallet, "paid", { tx });
  await db.setJSON(`tx/${tx}`, { wallet, ticket: t.id, time: Date.now() });
  await db.setJSON(`entry/${t.week}/${tx}`, { wallet, ticket: t.id, time: Date.now() });
  return json({ ticket: t.id, kind: "paid" });
}

async function score(req) {
  const { ticket, score, wave } = await req.json();
  if (typeof ticket !== "string" || !/^[a-f0-9]{32}$/.test(ticket)) return json({ error: "Bad ticket" }, 400);
  const s = Math.floor(Number(score)), w = Math.floor(Number(wave));
  if (!Number.isFinite(s) || s < 0 || !Number.isFinite(w) || w < 1) return json({ error: "Bad score" }, 400);
  const db = store();
  const t = await db.get(`ticket/${ticket}`, { type: "json" });
  if (!t) return json({ error: "Unknown ticket" }, 404);
  if (t.used) return json({ error: "Score already submitted for this game" }, 409);
  const secs = (Date.now() - t.created) / 1000;
  // Plausibility guard (manual review still recommended before payouts)
  const flagged = s > secs * 90 + 1500 || w > secs / 4 + 2;
  t.used = true; t.score = s; t.wave = w; t.ended = Date.now(); t.flagged = flagged;
  await db.setJSON(`ticket/${ticket}`, t);
  const week = weekId(new Date(t.created));
  const row = { wallet: t.wallet, score: s, wave: w, kind: t.kind, tx: t.tx || null, time: Date.now(), secs: Math.round(secs) };
  await db.setJSON(`${flagged ? "flag" : "score"}/${week}/${ticket}`, row);
  const lb = await leaderboard(db, week);
  const rank = lb.findIndex(r => r.wallet === t.wallet) + 1;
  return json({ ok: true, flagged, rank, best: lb[rank - 1]?.score ?? s });
}

async function rpcProxy(req) {
  const body = await req.text();
  if (body.length > 20000) return json({ error: "Too large" }, 413);
  let j; try { j = JSON.parse(body); } catch { return json({ error: "Bad JSON" }, 400); }
  if (Array.isArray(j) || !RPC_ALLOW.has(j.method)) return json({ error: "Method not allowed" }, 403);
  const r = await fetch(CFG.rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

async function admin(req) {
  const url = new URL(req.url);
  const key = env("ADMIN_KEY", "");
  if (!key || url.searchParams.get("key") !== key) return json({ error: "Unauthorized" }, 401);
  const week = url.searchParams.get("week") || weekId();
  const db = store();
  const { blobs } = await db.list({ prefix: `score/${week}/` });
  const scores = (await Promise.all(blobs.map(b => db.get(b.key, { type: "json" })))).filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const f = await db.list({ prefix: `flag/${week}/` });
  const flagged = (await Promise.all(f.blobs.map(b => db.get(b.key, { type: "json" })))).filter(Boolean);
  return json({ week, ...(await potInfo(db, week)), winner: scores[0] || null, scores, flagged });
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  try {
    if (req.method === "GET" && route === "status") return await status(req);
    if (req.method === "GET" && route === "admin") return await admin(req);
    if (req.method === "POST" && route === "claim-free") return await claimFree(req);
    if (req.method === "POST" && route === "start") return await start(req);
    if (req.method === "POST" && route === "score") return await score(req);
    if (req.method === "POST" && route === "rpc") return await rpcProxy(req);
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Server error" }, 500);
  }
};

export const config = { path: "/api/*" };
