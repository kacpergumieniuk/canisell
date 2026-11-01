/** Tiny per-isolate TTL cache (Workers isolates and the Node process each get their own). */
export class TtlCache<V> {
  private map = new Map<string, { at: number; value: V }>();
  constructor(
    private ttlMs: number,
    private max = 500,
  ) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  clear() {
    this.map.clear();
  }
  set(key: string, value: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { at: Date.now(), value });
  }
}

/**
 * Second-level cache on the Workers Cache API (shared by every isolate in a data center; the per-isolate map
 * above is only warm for the isolate that served the last request). A no-op outside Workers and wherever the
 * runtime ignores the Cache API (it stores nothing on some zones), so callers only ever see hits or misses.
 */
export interface EdgeCache<V> {
  get(key: string): Promise<V | undefined>;
  put(key: string, value: V): Promise<void>;
}

export function workersEdgeCache<V>(ttlSeconds: number, namespace: string, store?: Pick<Cache, "match" | "put">): EdgeCache<V> {
  const resolve = () => store ?? (globalThis as { caches?: { default?: Cache } }).caches?.default;
  // Synthetic, never-routed origin: the Cache API keys on a URL.
  const reqFor = (key: string) => new Request(`https://cache.invalid/${namespace}/${key.toLowerCase()}`);
  return {
    async get(key) {
      try {
        const res = await resolve()?.match(reqFor(key));
        return res ? ((await res.json()) as V) : undefined;
      } catch {
        return undefined;
      }
    },
    async put(key, value) {
      try {
        await resolve()?.put(
          reqFor(key),
          new Response(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttlSeconds}` },
          }),
        );
      } catch {
        // best effort
      }
    },
  };
}
