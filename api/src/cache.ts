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
  set(key: string, value: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { at: Date.now(), value });
  }
}
