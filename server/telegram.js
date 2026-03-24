// server/telegram.js
// Telegram notifier con messaggi "umani" + enrichment TRC2 via read on-chain (opzionale)
// + monitor scadenze giornaliero con memoria persistente su ../data/tg_expiry_state.json
//
// ✅ Compatibile con il tuo watcher:
// - per TRC2: evt.schema="trc2", evt.event=dec.name, evt.tokenId=dec.tokenId (se presente), evt.extra={...dec}
// - ConformityStatusChanged: status è in evt.extra.status
// - CertificateSuperseded: old/new sono in evt.extra.oldTokenId / evt.extra.newTokenId
//
// NOTE:
// - questo file usa ethers v5 (come il tuo decoders.js: ethers.utils.*).
// - enrichment on-chain è opzionale: se non passi rpcUrl+trc2Abi, funziona lo stesso (solo "umanizzazione").
// - parse_mode HTML per formattazione e link senza impazzire con escaping markdown.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MINT_INDEX_URL = "https://www.chainintegrate.it/develop/data/mint_index.json";

// cache in memoria (evita fetch ad ogni evento)
let mintIndexCache = null;          // Map<string, string>
let mintIndexLastLoad = 0;
const MINT_INDEX_TTL_MS = 60_000;   // ricarica max 1 volta al minuto

async function loadMintIndex(force = false) {
  const now = Date.now();
  if (!force && mintIndexCache && (now - mintIndexLastLoad) < MINT_INDEX_TTL_MS) {
    return mintIndexCache;
  }

  // Node 18+ ha fetch globale
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500); // 2.5s timeout
  try {
    const res = await fetch(MINT_INDEX_URL, { signal: ctrl.signal, headers: { "accept": "application/json" } });
    if (!res.ok) throw new Error(`mint_index HTTP ${res.status}`);
    const json = await res.json();

    const map = new Map();

    // Supporto: { "0x..": "Name", ... } oppure { items:[...] }
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const items = Array.isArray(json.items) ? json.items : null;

      if (items) {
        for (const it of items) {
          const k = String(it.tokenId || it.id || it.key || "").toLowerCase();
          const v = String(
            it.name || it.label || it.title ||
            it.certificateId || it.certificateID || it.certId ||
            it.documentURI || it.documentHash ||
            ""
          ).trim();
          if (k && v) map.set(k, v);
        }
      } else {
        for (const [k0, v0] of Object.entries(json)) {
          const k = String(k0).toLowerCase();
          const v = (typeof v0 === "string")
            ? v0.trim()
            : String(v0?.name || v0?.label || v0?.title || "").trim();
          if (k && v) map.set(k, v);
        }
      }
    }

    // Supporto: [ { tokenId, name }, ... ]
    if (Array.isArray(json)) {
      for (const it of json) {
        const k = String(it.tokenId || it.id || it.key || "").toLowerCase();
        const v = String(
          it.name || it.label || it.title ||
          it.certificateId || it.certificateID || it.certId ||
          it.documentURI || it.documentHash ||
          ""
        ).trim();
        if (k && v) map.set(k, v);
      }
    }

    mintIndexCache = map;
    mintIndexLastLoad = now;
    return mintIndexCache;
  } catch (_e) {
    // se fallisce e avevi una cache vecchia, usa quella
    if (mintIndexCache) return mintIndexCache;
    mintIndexCache = new Map();
    mintIndexLastLoad = now;
    return mintIndexCache;
  } finally {
    clearTimeout(t);
  }
}

function tokenNameFromIndex(tokenId) {
  const k = String(tokenId || "").toLowerCase();
  if (!k || !mintIndexCache) return null;
  return mintIndexCache.get(k) || null;
}

function fmtTokenId(tokenId) {
  const hex = shortHex(tokenId, 14, 10);
  const name = tokenNameFromIndex(tokenId);

  // Nome + hex corto (debug)
  if (name) return `${escHtml(name)} <code>${escHtml(hex)}</code>`;

  // fallback: solo hex
  return `<code>${escHtml(hex)}</code>`;
}

// -------------------------
// helpers output / format
// -------------------------
function safeText(s, max = 3500) {
  const t = String(s ?? "");
  // Telegram text max ~4096, stiamo larghi
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function shortHex(h, left = 10, right = 8) {
  const s = String(h || "");
  if (!s.startsWith("0x") || s.length < left + right + 2) return s;
  return s.slice(0, left) + "…" + s.slice(-right);
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function link(url, label) {
  if (!url) return escHtml(label);
  return `<a href="${escHtml(url)}">${escHtml(label)}</a>`;
}

function statusLabel(code) {
  const n = Number(code);
  if (n === 0) return "✅ Valid";
  if (n === 1) return "🚫 Revoked";
  if (n === 2) return "🔁 Superseded";
  if (Number.isFinite(n)) return `❓ status=${n}`;
  return "❓ status=—";
}

function fmtUtcFromSec(sec) {
  const n = Number(sec || 0);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function isZeroBytes32(x) {
  const s = String(x || "").toLowerCase();
  return s === "0x" + "0".repeat(64);
}

// --- TRC2 pickers (aderenti al tuo watcher) ---
function isTRC2(evt) {
  return String(evt?.schema || "").toLowerCase() === "trc2";
}
function trc2EventName(evt) {
  return evt?.event || evt?.extra?.name || null;
}
function pickTrc2TokenId(evt) {
  return evt?.tokenId || evt?.extra?.tokenId || null;
}
function pickTrc2Status(evt) {
  const st = evt?.status ?? evt?.extra?.status;
  if (st === 0 || st === 1 || st === 2) return st;
  if (st == null) return null;
  const n = Number(st);
  return Number.isFinite(n) ? n : null;
}
function pickSupersededPair(evt) {
  const oldTokenId = evt?.oldTokenId || evt?.extra?.oldTokenId || null;
  const newTokenId = evt?.newTokenId || evt?.extra?.newTokenId || null;
  return { oldTokenId, newTokenId };
}

// --- time formatter per evt.ts (secondi) ---
function pickEvtTs(evt) {
  // nel tuo normalizeLog passi blockTimestampSec -> in genere finisce in evt.ts (sec)
  // ma se cambia nome, aggiungi fallback qui
  const t = evt?.ts ?? evt?.timestamp ?? evt?.blockTimestampSec;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- Persistenza stato alert scadenze ----------
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// Differenza in giorni “di calendario” (UTC) tra due timestamp seconds
function diffDaysUtc(nowSec, targetSec) {
  const a = new Date(nowSec * 1000);
  const b = new Date(targetSec * 1000);
  const aDay = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bDay = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((bDay - aDay) / 86400000);
}

export function createTelegramNotifier({
  token,
  chatId,
  enabled = true,
  minIntervalMs = 1200,
  maxQueue = 200,
  allowKinds = null,       // es: new Set(["MINT","BURN","TRANSFER","LOG"])
  allowContracts = null,   // es: new Set(["0x..."])
  allowSchemas = null,     // es: new Set(["trc2"])

  // 🔧 opzionale: enrichment TRC2 via read on-chain
  rpcUrl = null,           // es: https://rpc.testnet.lukso.network
  trc2Abi = null,          // ABI minimale: getConformityData (+ supersededBy opzionale)
  explorerTxBase = null,   // es: https://explorer.execution.testnet.lukso.network/tx/
  explorerBlockBase = null,// es: https://explorer.execution.testnet.lukso.network/block/
  certCacheTtlMs = 60_000, // cache per read on-chain (evita martellate)
  showContractLine = true, // se vuoi togliere rumore, metti false

  // 🔔 monitor scadenze (1 volta al giorno)
  expiryEnabled = false,
  expiryContractAddress = null,     // address TRC2 da monitorare
  expiryCheckHourLocal = 16,        // ora (server locale) per check giornaliero
  expiryWarnDays = [7, 1],          // giorni prima
  expiryAlsoDayAfter = true,        // giorno dopo scadenza
  expiryStatePath = path.join(__dirname, "..", "data", "tg_expiry_state.json"),
} = {}) {
  const on = enabled && token && chatId;
  const api = token ? `https://api.telegram.org/bot${token}` : null;

  let q = [];
  let busy = false;

  // ethers v5 lazy + provider + cache contract + cache cert
  let _ethers = null;
  let _provider = null;
  const _contractCache = new Map(); // addr -> contract
  const _certCache = new Map();     // tokenIdLower -> { data, atMs }

  async function ensureEthers() {
    if (_ethers) return _ethers;
    _ethers = await import("ethers");
    return _ethers;
  }

  async function getProvider() {
    if (!rpcUrl) return null;
    if (_provider) return _provider;
    const e = await ensureEthers();
    _provider = new e.ethers.providers.JsonRpcProvider(rpcUrl);
    return _provider;
  }

  async function getTrc2Contract(addr) {
    const a = String(addr || "").toLowerCase();
    if (!a || !trc2Abi) return null;
    if (_contractCache.has(a)) return _contractCache.get(a);

    const prov = await getProvider();
    if (!prov) return null;

    const e = await ensureEthers();
    const c = new e.ethers.Contract(a, trc2Abi, prov);
    _contractCache.set(a, c);
    return c;
  }

  async function fetchConformity(addr, tokenId) {
    const a = String(addr || "").toLowerCase();
    const t = String(tokenId || "");
    if (!a || !t) return null;

    const key = t.toLowerCase();
    const cached = _certCache.get(key);
    const now = Date.now();
    if (cached && (now - cached.atMs) < certCacheTtlMs) return cached.data;

    const c = await getTrc2Contract(a);
    if (!c) return null;

    // getConformityData(bytes32) returns struct:
    // (certificateId, companyIdHash, batchIdHash, standardHash, issuedAt, validUntil, documentHash, documentURI, status)
    const data = await c.getConformityData(t);

    const norm = {
      certificateId: String(data?.certificateId || "").toLowerCase(),
      documentHash: String(data?.documentHash || "").toLowerCase(),
      issuedAt: data?.issuedAt?.toString?.() ? Number(data.issuedAt.toString()) : Number(data?.issuedAt || 0),
      validUntil: data?.validUntil?.toString?.() ? Number(data.validUntil.toString()) : Number(data?.validUntil || 0),
      documentURI: String(data?.documentURI || ""),
      status: data?.status?.toString?.() ? Number(data.status.toString()) : Number(data?.status ?? 0)
    };

    _certCache.set(key, { data: norm, atMs: now });
    return norm;
  }

  function pass(evt) {
    if (!evt) return false;

    const kind = String(evt.kind || "").toUpperCase();
    const caddr = String(evt.contract?.address || evt.address || "").toLowerCase();
    const schema = String(evt.schema || evt.decoded?.schema || "").toLowerCase();

    if (allowKinds && allowKinds.size && !allowKinds.has(kind)) return false;
    if (allowContracts && allowContracts.size && !allowContracts.has(caddr)) return false;
    if (allowSchemas && allowSchemas.size && !allowSchemas.has(schema)) return false;

    return true;
  }

  function txLink(txHash) {
    if (!txHash) return "—";
    if (!explorerTxBase) return `<code>${escHtml(shortHex(txHash, 14, 10))}</code>`;
    return link(`${explorerTxBase}${txHash}`, shortHex(txHash, 14, 10));
  }

  function blockLink(bn) {
    if (bn == null || bn === "—") return "—";
    if (!explorerBlockBase) return `<code>${escHtml(String(bn))}</code>`;
    return link(`${explorerBlockBase}${bn}`, `#${bn}`);
  }

  // --------
  // FORMAT
  // --------
  async function format(evt) {
    const kind = String(evt?.kind || "LOG").toUpperCase();

    const label = evt?.contract?.label || "Contract";
    const caddr = String(evt?.contract?.address || evt?.address || "").toLowerCase();

    // carico la mappa nomi tokenId->nome (cache + TTL)
    try { await loadMintIndex(); } catch {}

    const bn = evt?.blockNumber ?? "—";
    const tsSec = pickEvtTs(evt);
    const ts = tsSec ? fmtUtcFromSec(tsSec) : "—";

    // TRC2?
    const trc2 = isTRC2(evt);
    const name = trc2 ? trc2EventName(evt) : null;

    // --- 1) TRC2: Status changed (messaggio umano + enrichment)
    if (trc2 && name === "ConformityStatusChanged") {
      const tokenId = pickTrc2TokenId(evt);
      const st = pickTrc2Status(evt);

      let chainData = null;
      // enrichment solo se abbiamo rpc+abi+tokenId
      if (rpcUrl && trc2Abi && tokenId && caddr) {
        try { chainData = await fetchConformity(caddr, tokenId); } catch {}
      }

      const shownStatus = (chainData?.status ?? st);

      const lines = [];
      lines.push(`<b>🚨 Cambio stato certificato</b>`);
      lines.push(`Progetto: <b>${escHtml(label)}</b>`);
      if (tokenId) lines.push(`Token: ${fmtTokenId(tokenId)}`);

      if (shownStatus != null) lines.push(`Nuovo stato: <b>${escHtml(statusLabel(shownStatus))}</b>`);

      // dettagli "utili"
      if (chainData?.certificateId && !isZeroBytes32(chainData.certificateId)) {
        lines.push(`certId: <code>${escHtml(shortHex(chainData.certificateId, 14, 10))}</code>`);
      }
      if (chainData?.validUntil) {
        lines.push(`Scadenza: <b>${escHtml(fmtUtcFromSec(chainData.validUntil))}</b>`);
      }
      if (chainData?.documentHash && !isZeroBytes32(chainData.documentHash)) {
        lines.push(`docHash: <code>${escHtml(shortHex(chainData.documentHash, 14, 10))}</code>`);
      }
      if (chainData?.documentURI) {
        lines.push(`Documento: ${link(chainData.documentURI, "apri")}`);
      }

      // footer tecnico (compatto)
      lines.push(``);
      lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
      if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
      if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

      return safeText(lines.join("\n"));
    }

    // --- 2) TRC2: Superseded
    if (trc2 && name === "CertificateSuperseded") {
      const { oldTokenId, newTokenId } = pickSupersededPair(evt);

      const lines = [];
      lines.push(`<b>🔁 Certificato sostituito (supersede)</b>`);
      lines.push(`Progetto: <b>${escHtml(label)}</b>`);
      if (oldTokenId) lines.push(`Vecchio: ${fmtTokenId(oldTokenId)}`);
      if (newTokenId) lines.push(`Nuovo:  ${fmtTokenId(newTokenId)}`);

      lines.push(``);
      lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
      if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
      if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

      return safeText(lines.join("\n"));
    }

    // --- 3) Transfer / Mint / Burn (già “human-ish”)
    if (kind === "MINT" || kind === "BURN" || kind === "TRANSFER") {
      const from = evt?.from || evt?.extra?.from || null;
      const to = evt?.to || evt?.extra?.to || null;

      const lines = [];
      if (kind === "MINT") lines.push(`<b>🚀 Mint</b> — ${escHtml(label)}`);
      else if (kind === "BURN") lines.push(`<b>🔥 Burn</b> — ${escHtml(label)}`);
      else lines.push(`<b>🔁 Transfer</b> — ${escHtml(label)}`);

      if (from) lines.push(`Da: <code>${escHtml(shortHex(from))}</code>`);
      if (to) lines.push(`A:  <code>${escHtml(shortHex(to))}</code>`);

      // tokenId può essere bytes32 (LSP8/TRC2) o decimale (erc721-like) a seconda normalizer
      if (evt?.tokenId) lines.push(`Token: ${fmtTokenId(evt.tokenId)}`);

      if (evt?.amount != null) lines.push(`Amount: <code>${escHtml(String(evt.amount))}</code>`);

      lines.push(``);
      lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
      if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
      if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

      return safeText(lines.join("\n"));
    }

    // --- 4) Fallback: LOG pulito ma leggibile
    const lines = [];
    lines.push(`<b>🔔 ${escHtml(kind)}</b> — ${escHtml(label)}`);
    if (trc2 && name) lines.push(`Evento: <b>${escHtml(name)}</b>`);

    lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
    if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);

    if (evt?.from) lines.push(`Da: <code>${escHtml(shortHex(evt.from))}</code>`);
    if (evt?.to) lines.push(`A:  <code>${escHtml(shortHex(evt.to))}</code>`);

    // TRC2 extra utili se presenti
    if (trc2 && evt?.extra) {
      if (evt.extra.certificateId) lines.push(`certId: <code>${escHtml(shortHex(evt.extra.certificateId, 14, 10))}</code>`);
      if (evt.extra.status != null) lines.push(`Stato: <b>${escHtml(statusLabel(evt.extra.status))}</b>`);
      if (evt.extra.documentHash) lines.push(`docHash: <code>${escHtml(shortHex(evt.extra.documentHash, 14, 10))}</code>`);
      if (evt.extra.issuedAt) lines.push(`Issued: <code>${escHtml(String(evt.extra.issuedAt))}</code>`);
    }

    if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

    return safeText(lines.join("\n"));
  }

  async function send(text) {
    if (!on) return;

    const res = await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
      const desc = j?.description || `HTTP ${res.status}`;
      throw new Error(`Telegram sendMessage failed: ${desc}`);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (q.length) {
        const evt = q.shift();
        try {
          const text = await format(evt);
          await send(text);
        } catch (e) {
          // non bloccare la coda per un errore (es. flood control)
          console.warn("[tg] send failed:", e?.message || e);
        }
        await sleep(minIntervalMs);
      }
    } finally {
      busy = false;
    }
  }

  // ----------------------------------------------------
  // MONITOR SCADENZE (1 volta al giorno)
  // ----------------------------------------------------
  const expiryOn = !!(expiryEnabled && on && rpcUrl && trc2Abi);
  const expiryAddr = String(expiryContractAddress || "").toLowerCase();

  // stato persistente: tokens[tokenIdLower] -> { validUntil, sent:{d7,d1,dp1}, lastSeenAt, lastStatus, supersededBy }
  let expiryState = readJsonSafe(expiryStatePath, { tokens: {} });

  function getExpiryTokenEntry(tokenIdLower) {
    expiryState.tokens ||= {};
    expiryState.tokens[tokenIdLower] ||= { validUntil: 0, sent: {}, lastSeenAt: 0, lastStatus: null, supersededBy: null };
    expiryState.tokens[tokenIdLower].sent ||= {};
    return expiryState.tokens[tokenIdLower];
  }

  async function fetchSupersededByIfPossible(addr, tokenId) {
    try {
      const c = await getTrc2Contract(addr);
      if (!c?.supersededBy) return null; // ABI non include supersededBy
      const v = await c.supersededBy(tokenId);
      const s = String(v || "").toLowerCase();
      if (!s || isZeroBytes32(s)) return null;
      return s;
    } catch {
      return null;
    }
  }

  async function runExpiryCheckOnce() {
    if (!expiryOn) return;
    if (!expiryAddr) return; // deve essere esplicito: vogliamo "sorvegliare il contratto"

    // 1) lista tokenId da mint_index (cache)
    try { await loadMintIndex(true); } catch {}

    const map = mintIndexCache || new Map();
    const tokenIds = Array.from(map.keys()); // già lower-case

    if (!tokenIds.length) return;

    for (const tokenIdLower of tokenIds) {
      const tokenId = tokenIdLower;
      const entry = getExpiryTokenEntry(tokenIdLower);

      let chainData = null;
      try {
        chainData = await fetchConformity(expiryAddr, tokenId);
      } catch {
        continue;
      }

      if (!chainData || !chainData.validUntil) continue;

      const vu = Number(chainData.validUntil || 0);
      const st = Number(chainData.status ?? 0);

      // reset notifiche se rinnovo (validUntil cambia) o cambio stato
      if (entry.validUntil !== vu || entry.lastStatus !== st) {
        entry.validUntil = vu;
        entry.lastStatus = st;
        entry.sent = {};
      }

      // opzionale: capire supersede (se ABI presente)
      const supersededBy = await fetchSupersededByIfPossible(expiryAddr, tokenId);
      entry.supersededBy = supersededBy;

      const nowSec = Math.floor(Date.now() / 1000);
      const d = diffDaysUtc(nowSec, vu); // giorni a scadenza (positivo = futuro)

      // di solito non avviso su revoked/superseded (rumore). Se vuoi, togli questo blocco.
      if (st === 1 || st === 2) {
        entry.lastSeenAt = nowSec;
        writeJsonAtomic(expiryStatePath, expiryState);
        continue;
      }

      // “non rinnovato” = non superseded e validUntil non è cambiata (gestito sopra)
      const notRenewed = !supersededBy;

      const sendExpiryMsg = async (title, extraLines = []) => {
        const lines = [];
        lines.push(`<b>${title}</b>`);
        lines.push(`Contratto: <code>${escHtml(shortHex(expiryAddr))}</code>`);
        lines.push(`Token: ${fmtTokenId(tokenId)}`);
        lines.push(`Stato: <b>${escHtml(statusLabel(st))}</b>`);
        lines.push(`Scadenza: <b>${escHtml(fmtUtcFromSec(vu))}</b>`);
        if (chainData?.documentURI) lines.push(`Documento: ${link(chainData.documentURI, "apri")}`);
        if (supersededBy) lines.push(`SupersededBy: <code>${escHtml(shortHex(supersededBy, 14, 10))}</code>`);
        for (const l of extraLines) lines.push(l);
        await send(safeText(lines.join("\n")));
      };

      // 7 giorni prima
      if (Array.isArray(expiryWarnDays) && expiryWarnDays.includes(7) && d === 7 && !entry.sent.d7) {
        await sendExpiryMsg(`⏳ Certificato in scadenza tra 7 giorni`);
        entry.sent.d7 = true;
      }

      // 1 giorno prima
      if (Array.isArray(expiryWarnDays) && expiryWarnDays.includes(1) && d === 1 && !entry.sent.d1) {
        await sendExpiryMsg(`⚠️ Certificato in scadenza domani`);
        entry.sent.d1 = true;
      }

      // 1 giorno dopo (se non rinnovato)
      if (expiryAlsoDayAfter && d === -1 && notRenewed && !entry.sent.dp1) {
        await sendExpiryMsg(`🚨 Certificato scaduto (ieri) e non risulta rinnovato`, [
          `Suggerimento: emetti un nuovo token (supersede) oppure aggiorna la scadenza e verifica lo stato.`
        ]);
        entry.sent.dp1 = true;
      }

      entry.lastSeenAt = nowSec;

      // salva per persistenza anche in caso di crash
      writeJsonAtomic(expiryStatePath, expiryState);

      // pausa piccola per non martellare RPC se hai tanti token
      await sleep(150);
    }
  }

  function msUntilNextDaily(hourLocal) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(hourLocal || 9), 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  let _expiryTimer = null;
  let _expiryInterval = null;

  function startExpiryMonitor() {
    if (!expiryOn) return;
    if (!expiryAddr) return;

    // run subito (utile al deploy)
    runExpiryCheckOnce().catch(() => {});

    // poi allineo al prossimo check giornaliero
    const wait = msUntilNextDaily(expiryCheckHourLocal);
    _expiryTimer = setTimeout(() => {
      runExpiryCheckOnce().catch(() => {});
      _expiryInterval = setInterval(() => {
        runExpiryCheckOnce().catch(() => {});
      }, 24 * 60 * 60 * 1000);
    }, wait);
  }

  function stopExpiryMonitor() {
    if (_expiryTimer) clearTimeout(_expiryTimer);
    if (_expiryInterval) clearInterval(_expiryInterval);
    _expiryTimer = null;
    _expiryInterval = null;
  }

  // avvio automatico
  startExpiryMonitor();

  return {
    isEnabled: () => !!on,

    // opzionale: controlli esterni
    startExpiryMonitor: () => startExpiryMonitor(),
    stopExpiryMonitor: () => stopExpiryMonitor(),

    enqueue: (evt) => {
      if (!on) return;
      if (!pass(evt)) return;

      if (q.length >= maxQueue) q.shift(); // drop oldest
      q.push(evt);
      pump();
    }
  };
}

/**
 * ABI minimale TRC2 (comoda da copiare in chi crea il notifier):
 *
 * const trc2Abi = [
 *   "function getConformityData(bytes32 tokenId) view returns (tuple(bytes32 certificateId, bytes32 companyIdHash, bytes32 batchIdHash, bytes32 standardHash, uint256 issuedAt, uint256 validUntil, bytes32 documentHash, string documentURI, uint8 status))",
 *   "function supersededBy(bytes32 tokenId) view returns (bytes32)"
 * ];
 */
