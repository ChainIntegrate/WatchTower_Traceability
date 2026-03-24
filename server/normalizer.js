const ZERO = "0x0000000000000000000000000000000000000000";

export function normalizeLog({ log, blockTimestampSec, contractMeta, depositSet, userWalletMap }){
  const topic0 = String(log?.topics?.[0] || "").toLowerCase();

  const evt = {
    ts: blockTimestampSec || null,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    contract: {
      address: (contractMeta?.address || log.address || "").toLowerCase(),
      label: contractMeta?.label || "Unknown",
      key: contractMeta?.key || null,
      standard: contractMeta?.standard || null,
      symbolFallback: contractMeta?.symbolFallback || null
    },
    kind: "LOG",
    from: null,
    to: null,
    tokenId: null,
    amount: null,
    raw: {
      address: (log.address || "").toLowerCase(),
      topic0,
      topics: log.topics || [],
      data: log.data || "0x"
    },
    labels: {
      from: null,
      to: null
    }
  };

  // user labels (se già presenti)
  if (userWalletMap){
    // li settiamo dopo quando abbiamo from/to
  }

  // classify deposit based on from/to, se li abbiamo
  evt._classify = (from, to)=>{
    const f = (from || "").toLowerCase();
    const t = (to || "").toLowerCase();
    if (f === ZERO) return "MINT";
    if (t === ZERO) return "BURN";
    if (depositSet?.has(t)) return "DEPOSIT";
    if (depositSet?.has(f)) return "WITHDRAW";
    return "TRANSFER";
  };

  return evt;
}

export function attachFromTo(evt, { from, to, amount=null, tokenId=null, userWalletMap }){
  evt.from = from || null;
  evt.to   = to || null;
  if (amount != null) evt.amount = amount;
  if (tokenId != null) evt.tokenId = tokenId;

  // labels
  if (userWalletMap){
    const f = (evt.from || "").toLowerCase();
    const t = (evt.to || "").toLowerCase();
    evt.labels.from = userWalletMap[f]?.label || null;
    evt.labels.to   = userWalletMap[t]?.label || null;
  }

  // kind
  evt.kind = evt._classify(evt.from, evt.to);
  delete evt._classify;
  return evt;
}
