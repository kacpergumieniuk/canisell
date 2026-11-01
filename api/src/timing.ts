/**
 * Lightweight per-request timing. Phases may overlap (the engine runs RPC calls in parallel), so the
 * entries are wall-clock spans, not a partition of the total. Rendered as a `Server-Timing` header
 * (visible in browser devtools and to the client) and as one structured log line per paid request.
 * Nothing here is sensitive: phase names and millisecond durations only.
 */
export class Timings {
  private entries: Array<{ name: string; ms: number }> = [];
  private open = new Map<string, number>();
  private t0 = now();
  /** Work that should outlive the response (cache writes); the request handler hands it to waitUntil. */
  readonly background: Promise<unknown>[] = [];
  /** Free-form facts for the log line (cache hit, verdict, ...). Never put secrets here. */
  readonly info: Record<string, string | number | boolean | undefined> = {};

  add(name: string, ms: number) {
    this.entries.push({ name, ms: Math.round(ms * 10) / 10 });
  }

  start(name: string) {
    this.open.set(name, now());
  }

  end(name: string) {
    const s = this.open.get(name);
    if (s === undefined) return;
    this.open.delete(name);
    this.add(name, now() - s);
  }

  /** Times an already-started promise from now until it settles. */
  track<T>(name: string, p: Promise<T>): Promise<T> {
    const s = now();
    return p.finally(() => this.add(name, now() - s));
  }

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const s = now();
    try {
      return await fn();
    } finally {
      this.add(name, now() - s);
    }
  }

  get totalMs(): number {
    return Math.round((now() - this.t0) * 10) / 10;
  }

  get(name: string): number | undefined {
    return this.entries.find((e) => e.name === name)?.ms;
  }

  /** `a;dur=1.2, b;dur=3.4` — names are restricted to token characters. */
  header(): string {
    const parts = [...this.entries, { name: "total", ms: this.totalMs }].map((e) => `${e.name.replace(/[^A-Za-z0-9_-]/g, "_")};dur=${e.ms}`);
    if (typeof this.info.cache === "string") parts.push(`cache;desc="${this.info.cache.replace(/[^A-Za-z0-9_-]/g, "_")}"`);
    return parts.join(", ");
  }

  toJSON() {
    return Object.fromEntries([...this.entries.map((e) => [e.name, e.ms] as const), ["total", this.totalMs] as const]);
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
