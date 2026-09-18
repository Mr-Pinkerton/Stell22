import type { InventoryMovementActorKind } from "@prisma/client";

/**
 * Reusable actor snapshot for future SHADOW writers.
 * USER must carry the authenticated User.id. Terminal later = EMPLOYEE.
 * True automation later = SYSTEM. Marketplace/provider is not an actor.
 */
export type MovementActorSnapshot =
  | {
      actorKind: "USER";
      userId: string;
      actorDisplaySnapshot: string;
    }
  | {
      actorKind: "EMPLOYEE";
      employeeId: string;
      actorDisplaySnapshot: string;
    }
  | {
      actorKind: "SYSTEM";
      systemActorKey: string;
      actorDisplaySnapshot: string;
    };

export type MovementActorColumns = {
  actorKind: InventoryMovementActorKind;
  userId: string | null;
  employeeId: string | null;
  systemActorKey: string | null;
  actorDisplaySnapshot: string;
};

export const INVENTORY_MOVEMENT_ACTOR_REQUIRED =
  "InventoryMovement actor snapshot is missing a required identity field.";

function requireNonblank(value: string | undefined, message = INVENTORY_MOVEMENT_ACTOR_REQUIRED): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(message);
  return value as string;
}

/** Capture authenticated admin User.id before a future physical TX. */
export function userMovementActorFromAdmin(user: {
  id: string;
  name: string;
}): MovementActorSnapshot {
  return {
    actorKind: "USER",
    userId: requireNonblank(user.id, "USER actor requires authenticated User.id"),
    actorDisplaySnapshot: requireNonblank(user.name, "USER actor requires a display snapshot"),
  };
}

export function employeeMovementActor(employee: {
  id: string;
  fullName: string;
}): MovementActorSnapshot {
  return {
    actorKind: "EMPLOYEE",
    employeeId: requireNonblank(employee.id, "EMPLOYEE actor requires Employee.id"),
    actorDisplaySnapshot: requireNonblank(
      employee.fullName,
      "EMPLOYEE actor requires a display snapshot",
    ),
  };
}

export function systemMovementActor(input: {
  systemActorKey: string;
  actorDisplaySnapshot: string;
}): MovementActorSnapshot {
  return {
    actorKind: "SYSTEM",
    systemActorKey: requireNonblank(input.systemActorKey, "SYSTEM actor requires systemActorKey"),
    actorDisplaySnapshot: requireNonblank(
      input.actorDisplaySnapshot,
      "SYSTEM actor requires a display snapshot",
    ),
  };
}

export function movementActorColumns(actor: MovementActorSnapshot): MovementActorColumns {
  const actorDisplaySnapshot = requireNonblank(
    actor.actorDisplaySnapshot,
    "actorDisplaySnapshot is required",
  );
  if (actor.actorKind === "USER") {
    return {
      actorKind: "USER",
      userId: requireNonblank(actor.userId, "USER actor requires authenticated User.id"),
      employeeId: null,
      systemActorKey: null,
      actorDisplaySnapshot,
    };
  }
  if (actor.actorKind === "EMPLOYEE") {
    return {
      actorKind: "EMPLOYEE",
      userId: null,
      employeeId: requireNonblank(actor.employeeId, "EMPLOYEE actor requires Employee.id"),
      systemActorKey: null,
      actorDisplaySnapshot,
    };
  }
  return {
    actorKind: "SYSTEM",
    userId: null,
    employeeId: null,
    systemActorKey: requireNonblank(actor.systemActorKey, "SYSTEM actor requires systemActorKey"),
    actorDisplaySnapshot,
  };
}
