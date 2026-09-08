// buildPathTree/extractTitle are already covered via their re-export in index.test.ts
// (they moved here from index.ts in WP-7 Ф117, tests weren't duplicated). This file covers
// utf8ByteLength, added in Ф122 and not re-exported from index.ts.

import { describe, it, expect } from "vitest";
import { utf8ByteLength } from "./path-tree.js";

describe("utf8ByteLength", () => {
  it("counts ASCII content one byte per character", () => {
    expect(utf8ByteLength("# Intro\n\nBody text.")).toBe(19);
  });

  it("counts multi-byte UTF-8 characters correctly, not by character count", () => {
    // Cyrillic characters are 2 bytes each in UTF-8 — a naive .length (UTF-16 code units)
    // would report 5, not the actual byte size a client cares about for "file size".
    expect(utf8ByteLength("Привет")).toBe(12);
  });

  it("returns 0 for an empty string", () => {
    expect(utf8ByteLength("")).toBe(0);
  });
});
