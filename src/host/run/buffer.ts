/**
 * Bounded per-run output buffer.
 *
 * Keeps the newest bytes of a run's combined output up to a fixed capacity
 * and tracks how many leading bytes were dropped, so stream consumers can
 * resume from an absolute byte offset after a reconnect (see
 * `RunStreamFrame` in the wire contract).
 */

export interface RingBufferSnapshot {
  text: string;
  /** Absolute byte offset of the first retained byte. */
  offset: number;
  /** Total bytes ever appended (== absolute offset one past the newest byte). */
  nextOffset: number;
  /** True when bytes before `offset` were dropped by the capacity cap. */
  truncated: boolean;
}

export class OutputRingBuffer {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private droppedBytes = 0;
  private totalBytes = 0;

  /** Spill file reported by a lossy shell read, when the implementation provides one. */
  spillPath?: string | undefined;

  constructor(private readonly capacityBytes: number) {
    if (!Number.isFinite(capacityBytes) || capacityBytes < 1) {
      throw new RangeError(`Invalid ring buffer capacity: ${capacityBytes}`);
    }
  }

  get baseOffset(): number {
    return this.droppedBytes;
  }

  get size(): number {
    return this.totalBytes;
  }

  /**
   * Append one output chunk. Returns the absolute byte offset the chunk
   * started at, or undefined for an empty chunk.
   */
  append(text: string): { offset: number; text: string } | undefined {
    if (text.length === 0) return undefined;
    const chunk = Buffer.from(text, 'utf8');
    const offset = this.totalBytes;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    this.totalBytes += chunk.length;
    this.evict();
    return { offset, text };
  }

  private evict(): void {
    while (this.retainedBytes > this.capacityBytes) {
      const excess = this.retainedBytes - this.capacityBytes;
      const head = this.chunks[0];
      if (head === undefined) return;
      if (head.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= head.length;
        this.droppedBytes += head.length;
      } else {
        // Copy so the retained tail does not pin the original (possibly large) chunk.
        this.chunks[0] = Buffer.from(head.subarray(excess));
        this.retainedBytes -= excess;
        this.droppedBytes += excess;
      }
    }
  }

  /** Everything currently retained. */
  snapshot(): RingBufferSnapshot {
    const result = this.read(this.baseOffset);
    return { ...result, truncated: this.droppedBytes > 0 };
  }

  /**
   * Read from an absolute byte offset. Offsets older than the retained
   * window clamp to the window start and report `truncated`.
   */
  read(offset = 0): RingBufferSnapshot {
    const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    // Clamp into [baseOffset, totalBytes]: never report an offset beyond nextOffset.
    const start = Math.min(Math.max(requested, this.baseOffset), this.totalBytes);
    const skip = Math.min(start - this.baseOffset, this.retainedBytes);
    const text = Buffer.concat(this.chunks).subarray(skip).toString('utf8');
    return {
      text,
      offset: start,
      nextOffset: this.totalBytes,
      truncated: requested < this.baseOffset,
    };
  }
}
