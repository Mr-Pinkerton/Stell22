/**
 * First-match pg_hba rules for the disposable admission file.
 * A superuser session that can rewrite this file is outside the rule set.
 */

export type HbaConnection = "local" | "host";

export type HbaRule = {
  connection: HbaConnection;
  database: string;
  user: string;
  address: string | null;
  method: string;
};

export type HbaAttempt = {
  connection: HbaConnection;
  database: string;
  user: string;
  address: string | null;
};

const REJECT_ADDRESSES = ["127.0.0.1/32", "::1/128", "0.0.0.0/0", "::/0"] as const;

export function restrictiveHba(admittedRole: string, extraScramUsers: readonly string[] = []): string {
  const lines = ["# test-owned admission; default reject"];
  lines.push(ruleLine("local", "all", admittedRole, null, "scram-sha-256"));
  for (const user of extraScramUsers) {
    lines.push(ruleLine("local", "all", user, null, "scram-sha-256"));
  }
  lines.push(ruleLine("local", "all", "all", null, "reject"));
  lines.push(ruleLine("host", "all", admittedRole, "127.0.0.1/32", "scram-sha-256"));
  lines.push(ruleLine("host", "all", admittedRole, "::1/128", "scram-sha-256"));
  for (const user of extraScramUsers) {
    lines.push(ruleLine("host", "all", user, "127.0.0.1/32", "scram-sha-256"));
    lines.push(ruleLine("host", "all", user, "::1/128", "scram-sha-256"));
  }
  for (const address of REJECT_ADDRESSES) {
    lines.push(ruleLine("host", "all", "all", address, "reject"));
  }
  return `${lines.join("\n")}\n`;
}

export function permissiveTrustHba(): string {
  return [
    "local all all trust",
    "host all all 127.0.0.1/32 trust",
    "host all all ::1/128 trust",
    "host all all 0.0.0.0/0 trust",
    "host all all ::/0 trust",
    "",
  ].join("\n");
}

export function parseHba(text: string): HbaRule[] {
  const rules: HbaRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts[0] !== "local" && parts[0] !== "host") continue;
    if (parts[0] === "local") {
      if (parts.length < 4) continue;
      rules.push({
        connection: "local",
        database: parts[1] ?? "",
        user: parts[2] ?? "",
        address: null,
        method: parts[3] ?? "",
      });
      continue;
    }
    if (parts.length < 5) continue;
    rules.push({
      connection: "host",
      database: parts[1] ?? "",
      user: parts[2] ?? "",
      address: parts[3] ?? "",
      method: parts[4] ?? "",
    });
  }
  return rules;
}

export function firstMatch(rules: readonly HbaRule[], attempt: HbaAttempt): HbaRule | null {
  for (const rule of rules) {
    if (rule.connection !== attempt.connection) continue;
    if (rule.database !== "all" && rule.database !== attempt.database) continue;
    if (rule.user !== "all" && rule.user !== attempt.user) continue;
    if (rule.connection === "host" && rule.address !== attempt.address) continue;
    return rule;
  }
  return null;
}

export function isDefaultReject(text: string, admittedRole: string): boolean {
  const rules = parseHba(text);
  if (rules.length === 0) return false;
  if (rules.some((rule) => rule.method !== "reject" && rule.method !== "scram-sha-256")) return false;
  if (rules.some((rule) => rule.user === "all" && rule.method !== "reject")) return false;
  if (rules.some((rule) => rule.method === "scram-sha-256" && rule.user !== admittedRole)) return false;
  const localAdmitted = firstMatch(rules, { connection: "local", database: "app", user: admittedRole, address: null });
  const localOther = firstMatch(rules, { connection: "local", database: "app", user: "stell22", address: null });
  const hostAdmitted = firstMatch(rules, {
    connection: "host",
    database: "app",
    user: admittedRole,
    address: "127.0.0.1/32",
  });
  const hostOther = firstMatch(rules, {
    connection: "host",
    database: "app",
    user: "stell22",
    address: "127.0.0.1/32",
  });
  return (
    localAdmitted?.method === "scram-sha-256" &&
    localOther?.method === "reject" &&
    hostAdmitted?.method === "scram-sha-256" &&
    hostOther?.method === "reject"
  );
}

function ruleLine(
  connection: HbaConnection,
  database: string,
  user: string,
  address: string | null,
  method: string,
): string {
  if (connection === "local") return `local ${database} ${user} ${method}`;
  return `host ${database} ${user} ${address ?? ""} ${method}`;
}
