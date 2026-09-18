import { describe, expect, it } from "vitest";
import {
  employeeMovementActor,
  movementActorColumns,
  systemMovementActor,
  userMovementActorFromAdmin,
} from "@/server/internal/inventory-movement-actor";

describe("userMovementActorFromAdmin", () => {
  it("captures authenticated User.id", () => {
    const actor = userMovementActorFromAdmin({ id: "user-1", name: "Иван" });
    expect(actor).toEqual({
      actorKind: "USER",
      userId: "user-1",
      actorDisplaySnapshot: "Иван",
    });
    expect(movementActorColumns(actor)).toEqual({
      actorKind: "USER",
      userId: "user-1",
      employeeId: null,
      systemActorKey: null,
      actorDisplaySnapshot: "Иван",
    });
  });

  it("rejects a missing user id", () => {
    expect(() => userMovementActorFromAdmin({ id: "  ", name: "Иван" })).toThrow(
      /User\.id/,
    );
  });
});

describe("employee and system actors", () => {
  it("maps terminal employee and automation without treating a marketplace as actor", () => {
    expect(movementActorColumns(employeeMovementActor({ id: "emp-1", fullName: "Пётр" }))).toEqual({
      actorKind: "EMPLOYEE",
      userId: null,
      employeeId: "emp-1",
      systemActorKey: null,
      actorDisplaySnapshot: "Пётр",
    });
    expect(
      movementActorColumns(
        systemMovementActor({ systemActorKey: "ozon-sync", actorDisplaySnapshot: "ozon-sync" }),
      ),
    ).toEqual({
      actorKind: "SYSTEM",
      userId: null,
      employeeId: null,
      systemActorKey: "ozon-sync",
      actorDisplaySnapshot: "ozon-sync",
    });
  });
});
