/**
 * Запуск Vitest с каноническим cwd (Windows: регистр буквы диска D: vs d:).
 * Без этого Vitest/Vite могут загрузить @vitest/runner дважды →
 * «Cannot read properties of undefined (reading 'config')» во всех тестах.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = realpathSync.native(root);
const vitestBin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const args = process.argv.slice(2);

const result = spawnSync(process.execPath, [vitestBin, ...args], {
  cwd,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
