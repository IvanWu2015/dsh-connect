/**
 * Read a DSH session.jsonl.zstd transcript (concatenated zstd frames) and print
 * events mentioning images or the image-related injected text, to see what the
 * agent actually received.
 * Usage: node packages/connect/test/dump-session.mjs <path-to-session.jsonl.zstd>
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** Replicates dsh-session-persistence-jsonl's frame scanner: find each frame's [start,end). */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("reserved frame-header bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) break;
  }
  return frames;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node dump-session.mjs <session.jsonl.zstd>");
  process.exit(1);
}
const buf = readFileSync(file);
const frames = scanZstdFrames(buf);
console.log(`frames: ${frames.length}`);
const parts = frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8"));
const text = parts.join("");
console.log(`decoded len: ${text.length}`);

// Print the head of the transcript.
console.log("=== HEAD (first 1500 chars) ===");
console.log(text.slice(0, 1500));

// Then image-related events.
console.log("\n=== IMAGE-RELATED LINES ===");
const lines = text.split("\n").filter((l) => l.trim() !== "");
let printed = 0;
for (const line of lines) {
  if (/image|图片|\.dsh-connect-images|imageError|vision/i.test(line)) {
    console.log(`--- line (len ${line.length})`);
    console.log(line.length > 1500 ? line.slice(0, 1500) + "…" : line);
    printed++;
    if (printed >= 15) break;
  }
}
if (printed === 0) console.log("(none found)");

// Keyword presence scan.
console.log("\n=== KEYWORD SCAN ===");
for (const kw of [".dsh-connect-images", "图片已保存", "未能自动分析", "图片内容说明", "imageError", "图片下载失败", "img_v3"]) {
  const idx = text.indexOf(kw);
  console.log(`${kw} -> ${idx !== -1 ? "FOUND at " + idx : "not found"}`);
}

