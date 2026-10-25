import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { P1_MIGRATION_NAME } from "@/server/internal/p1-isolated-runner/contract";

/** Migrations added after the pinned P1 cutover. They are not part of the 45-row historical set. */
export function isMigrationAfterPinnedP1(name: string): boolean {
  return name > P1_MIGRATION_NAME;
}

/** Copy post-P1 migration files from HEAD into a rehearsal tree. Returns how many SQL files were copied. */
export function copyMigrationsAfterPinnedP1(destinationRoot: string): number {
  const listed = spawnSync("git", ["ls-files", "prisma/migrations"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  let copied = 0;
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const name = relative.split("/")[2];
    if (!name || !isMigrationAfterPinnedP1(name)) continue;
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], {
      encoding: "buffer",
      windowsHide: true,
    });
    if (shown.status !== 0) throw new Error(`git show failed for ${relative}`);
    const target = path.join(destinationRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
    if (relative.endsWith("/migration.sql")) copied += 1;
  }
  return copied;
}
