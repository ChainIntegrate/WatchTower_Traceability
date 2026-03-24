// server/store.js
export class RingStore {
  constructor(max = 5000){
    this.max = Math.max(100, Number(max) || 5000);
    this.arr = [];
    this.total = 0;
    this.lastBlock = null;
    this.startedAt = Date.now();
  }

  push(evt){
    this.total++;
    this.arr.push(evt);
    if (this.arr.length > this.max) this.arr.shift();
    if (evt?.blockNumber != null) this.lastBlock = evt.blockNumber;
  }

  list({ limit=200, type=null, contract=null, q=null } = {}){
    let out = this.arr.slice().reverse();

    if (type){
      const T = String(type).toUpperCase();
      out = out.filter(x => String(x.kind || "").toUpperCase() === T);
    }

    if (contract){
      const C = String(contract).toLowerCase();
      out = out.filter(x => String(x.contract?.address || "").toLowerCase() === C);
    }

    if (q){
      const s = String(q).toLowerCase();
      out = out.filter(x => {
        const hay = [
          x.txHash, x.contract?.address, x.contract?.label,
          x.from, x.to, x.kind, x.tokenId, x.amount,
          x.raw?.topic0
        ].map(v => String(v || "").toLowerCase()).join(" ");
        return hay.includes(s);
      });
    }

   limit = Math.max(1, Math.min(this.max, Number(limit) || 200));

    return out.slice(0, limit);
  }

  stats(){
    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      buffered: this.arr.length,
      totalSeen: this.total,
      lastBlock: this.lastBlock,
      uptimeSec
    };
  }
}
