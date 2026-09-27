import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));

function catchBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /catch\s*\([^)]*\)\s*\{/g;
  for (const match of source.matchAll(re)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

describe("terminal replay conflict keeps the draft", () => {
  it.each(["torcovka-screen.tsx", "prisadka-screen.tsx", "upakovka-screen.tsx", "hours-screen.tsx"])(
    "%s reports a submit failure without success or clearing the draft",
    (file) => {
      const source = readFileSync(path.join(dir, file), "utf8");
      const blocks = catchBlocks(source);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain("toast.error");
        expect(block).not.toContain("clearDraft");
        expect(block).not.toContain("toast.success");
        expect(block).not.toContain("newRequestId");
      }
    },
  );
});
