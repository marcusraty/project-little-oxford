// BoundedSet — string set with insertion-order eviction at a capacity.
// Used by AuditEngine.seenIds so a long-running session can't grow the
// dedup set without bound. Eviction is FIFO (oldest insertion), which is
// fine for dedup-on-id: a re-emitted event whose id has been evicted will
// just double-write, which is bounded by the JSONL append rate.

export class BoundedSet {
  private set = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`BoundedSet capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  has(value: string): boolean { return this.set.has(value); }

  add(value: string): void {
    if (this.set.has(value)) return;
    this.set.add(value);
    if (this.set.size > this.capacity) {
      // Set iteration is insertion order, so .values().next() is the oldest.
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }

  get size(): number { return this.set.size; }

  clear(): void { this.set.clear(); }
}
