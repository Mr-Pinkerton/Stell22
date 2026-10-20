import { describe, expect, it } from "vitest";
import { firstMatch, isDefaultReject, parseHba, permissiveTrustHba, restrictiveHba } from "@/server/internal/p1-privileged-writer-barrier/hba";
import { inferSqlState } from "@/server/internal/p1-privileged-writer-barrier/probe";

describe("disposable pg_hba admission", () => {
  it("rejects every login except the admitted role", () => {
    const text = restrictiveHba("p1pb_barrier");
    expect(isDefaultReject(text, "p1pb_barrier")).toBe(true);
    const rules = parseHba(text);
    expect(firstMatch(rules, { connection: "host", database: "app", user: "stell22", address: "127.0.0.1/32" })?.method).toBe(
      "reject",
    );
    expect(firstMatch(rules, { connection: "local", database: "app", user: "p1wc_migrator", address: null })?.method).toBe(
      "reject",
    );
    expect(firstMatch(rules, { connection: "host", database: "app", user: "p1pb_barrier", address: "127.0.0.1/32" })?.method).toBe(
      "scram-sha-256",
    );
  });

  it("lets an earlier allow line beat a later reject", () => {
    const text = restrictiveHba("p1pb_barrier", ["p1wc_migrator"]);
    expect(isDefaultReject(text, "p1pb_barrier")).toBe(false);
    const rules = parseHba(text);
    expect(firstMatch(rules, { connection: "host", database: "app", user: "p1wc_migrator", address: "127.0.0.1/32" })?.method).toBe(
      "scram-sha-256",
    );
  });

  it("does not treat a trust file as a barrier", () => {
    expect(isDefaultReject(permissiveTrustHba(), "p1pb_barrier")).toBe(false);
    expect(firstMatch(parseHba(permissiveTrustHba()), {
      connection: "local",
      database: "app",
      user: "stell22",
      address: null,
    })?.method).toBe("trust");
  });

  it("maps a pg_hba reject line without a printed SQLSTATE to 28000", () => {
    const text = 'psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1", user "stell22", database "p1wc_2ac7ec35", no encryption\n';
    expect(inferSqlState(text)).toEqual({ code: "28000", inferred: true });
    expect(inferSqlState("ERROR:  42501: permission denied")).toEqual({ code: "42501", inferred: false });
  });
});
