import { test } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter, LineOverflowError, MAX_LINE_BYTES } from "../src/framing.ts";

// transport.md: "v0 components cap at 16 MiB"
test("default max line size is 16 MiB", () => {
  assert.equal(MAX_LINE_BYTES, 16 * 1024 * 1024);
});

// transport.md: "A reader buffers bytes, splits on \n, and parses each line"
test("emits one line per newline-terminated chunk", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":1}\n')), ['{"a":1}']);
});

test("emits multiple lines arriving in one chunk", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
});

// transport.md: "a socket is a byte stream with no message boundaries;
// reads may slice messages anywhere"
test("joins a line split across chunk boundaries", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a"')), []);
  assert.deepEqual(s.push(Buffer.from(":1")), []);
  assert.deepEqual(s.push(Buffer.from('}\n{"b"')), ['{"a":1}']);
  assert.deepEqual(s.push(Buffer.from(":2}\n")), ['{"b":2}']);
});

test("does not split a multi-byte UTF-8 character cut across chunks", () => {
  const s = new LineSplitter();
  const bytes = Buffer.from('{"a":"é"}\n');
  assert.deepEqual(s.push(bytes.subarray(0, 7)), []);
  assert.deepEqual(s.push(bytes.subarray(7)), ['{"a":"é"}']);
});

// transport.md: "A reader enforces a maximum message size ... unbounded
// line-buffering is an out-of-memory hazard"
test("throws LineOverflowError when buffered bytes exceed max with no newline", () => {
  const s = new LineSplitter(8);
  s.push(Buffer.from("12345"));
  assert.throws(() => s.push(Buffer.from("6789")), LineOverflowError);
});

test("throws LineOverflowError when a complete line exceeds max", () => {
  const s = new LineSplitter(4);
  assert.throws(() => s.push(Buffer.from("123456\n")), LineOverflowError);
});

test("a line exactly at max is accepted", () => {
  const s = new LineSplitter(4);
  assert.deepEqual(s.push(Buffer.from("1234\n")), ["1234"]);
});

// boundary: a partial buffer of exactly max bytes is not an overflow — the
// next chunk may be the newline that completes a max-size line
test("a partial buffer of exactly max bytes completed by a newline is accepted", () => {
  const s = new LineSplitter(4);
  assert.deepEqual(s.push(Buffer.from("1234")), []);
  assert.deepEqual(s.push(Buffer.from("\n")), ["1234"]);
});

// transport.md: "reads may slice messages anywhere" — a single large message
// (multi-MB respond context) split across many small TCP chunks must arrive
// intact and be emitted exactly once, without recopying a growing buffer per
// chunk (the O(n^2) hazard this splitter avoids).
test("a >1MB message split across many small chunks arrives intact, emitted once", () => {
  const s = new LineSplitter();
  const payload = JSON.stringify({ big: "x".repeat(1_500_000), n: 42 });
  const bytes = Buffer.from(payload + "\n");
  const emitted: string[] = [];
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const lines = s.push(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    // every chunk before the final (newline-bearing) one completes nothing
    emitted.push(...lines);
  }
  assert.equal(emitted.length, 1, "the whole message is emitted exactly once");
  assert.equal(emitted[0], payload, "reassembled byte-for-byte");
  assert.deepEqual(JSON.parse(emitted[0]), { big: "x".repeat(1_500_000), n: 42 });
});
