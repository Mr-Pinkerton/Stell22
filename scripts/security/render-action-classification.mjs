import fs from "node:fs";
import path from "node:path";
import { actionPolicy } from "./server-action-policy.mjs";

const labels = {
  ADMIN_ACTION: "Client-callable admin read/write; requires `requireAdmin()` first.",
  TERMINAL_ACTION: "Post-PIN terminal endpoint; requires terminal session.",
  AUTH_ACTION: "Session establishment/teardown.",
  PUBLIC_INTENTIONAL: "Deliberately anonymous Server Action.",
  INTERNAL_SERVER: "Server-to-server helper; must not be in the action manifest.",
};

let markdown = `# Этап 0.5: целевая классификация Server Actions

Сгенерировано из единственного machine-readable источника:
\`scripts/security/server-action-policy.mjs\`.

Классификация относится к **125 экспортам до remediation**. После переноса
\`INTERNAL_SERVER\` ожидается 111 публичных Server Actions.

| Категория | Количество | Инвариант |
| --------- | ---------- | --------- |
`;
for (const [category, keys] of Object.entries(actionPolicy)) {
  markdown += `| \`${category}\` | **${keys.length}** | ${labels[category]} |\n`;
}

for (const [category, keys] of Object.entries(actionPolicy)) {
  markdown += `\n## ${category}\n\n`;
  if (keys.length === 0) {
    markdown += "_Нет функций._\n";
    continue;
  }
  for (const key of keys) markdown += `- \`${key}\`\n`;
}

const output = path.join(process.cwd(), "audit", "00.5-remediation-classification.md");
fs.writeFileSync(output, markdown);
console.log(`Wrote ${output}`);

