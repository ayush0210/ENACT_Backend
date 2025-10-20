const LRU = new Map();
export function getCached(k) {
    return LRU.get(k);
}
export function setCached(k, v, ms = 300000) {
    // 5 min
    LRU.set(k, { v, exp: Date.now() + ms });
}
export function purge() {
    const now = Date.now();
    for (const [k, obj] of LRU) if (obj.exp < now) LRU.delete(k);
}
