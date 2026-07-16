// transport.md: NDJSON framing — buffer bytes, split on \n, one message per
// line, with a max line size ("v0 components cap at 16 MiB").
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class LineOverflowError extends Error {
  constructor(max: number) {
    super(`line exceeds max message size of ${max} bytes`);
    this.name = "LineOverflowError";
  }
}

export class LineSplitter {
  // Pending bytes of an unfinished line, held as chunk slices (no copy) until
  // a newline completes the line — then concat'd once. Concatenating per
  // chunk instead (partial = concat(partial, chunk)) re-copies a growing
  // buffer for every chunk, so a multi-MB line split across many TCP reads
  // costs O(n^2); accumulating references keeps it O(n).
  #chunks: Buffer[] = [];
  #pendingBytes = 0;
  readonly #max: number;

  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.#max = maxLineBytes;
  }

  /** Feed bytes; returns the complete lines they finish (without the \n). */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      // line length = bytes carried from earlier chunks + this chunk's slice
      const lineBytes = this.#pendingBytes + (nl - start);
      if (lineBytes > this.#max) throw new LineOverflowError(this.#max);
      if (this.#chunks.length === 0) {
        // empty-partial fast path: the whole line is in this chunk, decode it
        // directly without an intermediate concat
        lines.push(chunk.toString("utf8", start, nl));
      } else {
        // concat the raw bytes before decoding so a multi-byte UTF-8 char cut
        // across chunk boundaries is never split mid-character
        this.#chunks.push(chunk.subarray(start, nl));
        lines.push(Buffer.concat(this.#chunks).toString("utf8"));
        this.#chunks = [];
      }
      this.#pendingBytes = 0;
      start = nl + 1;
    }
    // trailing bytes after the last newline carry over as the next partial
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      this.#chunks.push(tail);
      this.#pendingBytes += tail.length;
    }
    // transport.md: close on oversize — "unbounded line-buffering is an
    // out-of-memory hazard, since a peer can send bytes with no delimiter".
    if (this.#pendingBytes > this.#max) throw new LineOverflowError(this.#max);
    return lines;
  }
}
