import fs from "node:fs";
import path from "node:path";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

export function acquireHostLock(lockPath: string, owner: string): { release: () => void } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle: number;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch {
    throw refusal(
      "BLOCKED",
      "CONCURRENT_EXECUTION",
      "Another disposable runner holds the host lock",
    );
  }
  fs.writeFileSync(handle, `${owner}\n`, "utf8");
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      fs.closeSync(handle);
      fs.unlinkSync(lockPath);
    },
  };
}
