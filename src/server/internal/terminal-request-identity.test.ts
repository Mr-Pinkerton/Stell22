import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_REQUEST_ALREADY_RECORDED,
  decideHoursReplay,
  decidePrisadkaReplay,
  decideTorcovkaReplay,
  decideUpakovkaReplay,
  guardConfirmedUnrecorded,
  UPAKOVKA_ALREADY_RECORDED,
} from "@/server/internal/terminal-request-identity";

describe("terminal request identity", () => {
  it("names the conflict without another employee's data", () => {
    expect(TERMINAL_REQUEST_ALREADY_RECORDED).toContain("Проверьте ранее внесённую операцию");
    expect(TERMINAL_REQUEST_ALREADY_RECORDED).not.toContain("другому");
    expect(TERMINAL_REQUEST_ALREADY_RECORDED).not.toMatch(/сотрудник|работник/i);
  });

  it("matches torcovka when near-equal lengths are the same canonical blanks", () => {
    const stored = {
      employeeId: "emp-a",
      type: "TORCOVKA",
      batchId: "batch-1",
      railLotId: "lot-1",
      railsTaken: 2,
      lines: [
        {
          quantity: 5,
          blankLengthM: new Prisma.Decimal("0.7360"),
          blankSort: "SORT1",
        },
      ],
    };
    expect(
      decideTorcovkaReplay(stored, {
        employeeId: "emp-a",
        batchId: "batch-1",
        railLotId: "lot-1",
        railsTaken: 2,
        picks: [
          { lengthM: 0.736, sort: "SORT1", quantity: 2 },
          { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
        ],
      }),
    ).toBe("MATCH");
    expect(
      decideTorcovkaReplay(stored, {
        employeeId: "emp-a",
        batchId: "batch-1",
        railLotId: "lot-1",
        railsTaken: 2,
        picks: [{ lengthM: 0.7361, sort: "SORT1", quantity: 5 }],
      }),
    ).toBe("CONFLICT");
  });

  it("conflicts when torcovka rails, sort, lot, or employee differ", () => {
    const stored = {
      employeeId: "emp-a",
      type: "TORCOVKA",
      batchId: "batch-1",
      railLotId: "lot-1",
      railsTaken: 2,
      lines: [{ quantity: 1, blankLengthM: "1.0000", blankSort: "SORT1" }],
    };
    const base = {
      employeeId: "emp-a",
      batchId: "batch-1",
      railLotId: "lot-1",
      railsTaken: 2,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 1 }],
    };
    expect(decideTorcovkaReplay(stored, { ...base, railsTaken: 3 })).toBe("CONFLICT");
    expect(
      decideTorcovkaReplay(stored, {
        ...base,
        picks: [{ lengthM: 1, sort: "SORT2", quantity: 1 }],
      }),
    ).toBe("CONFLICT");
    expect(decideTorcovkaReplay(stored, { ...base, railLotId: "lot-2" })).toBe("CONFLICT");
    expect(decideTorcovkaReplay(stored, { ...base, employeeId: "emp-b" })).toBe("CONFLICT");
    expect(decideTorcovkaReplay({ ...stored, type: "HOURS" }, base)).toBe("CONFLICT");
    expect(
      decideTorcovkaReplay(
        { ...stored, lines: [{ quantity: 1, blankLengthM: null, blankSort: "SORT1" }] },
        base,
      ),
    ).toBe("CONFLICT");
  });

  it("sums prisadka lines split across material sources", () => {
    const stored = {
      employeeId: "emp-a",
      type: "PRISADKA",
      lines: [
        {
          detailId: "det-1",
          quantity: 1,
          prisadkaTorcevaya: true,
          prisadkaPloskost: false,
        },
        {
          detailId: "det-1",
          quantity: 2,
          prisadkaTorcevaya: true,
          prisadkaPloskost: false,
        },
      ],
    };
    expect(
      decidePrisadkaReplay(stored, {
        employeeId: "emp-a",
        picks: [{ detailId: "det-1", kind: "torcev", quantity: 3 }],
      }),
    ).toBe("MATCH");
    expect(
      decidePrisadkaReplay(stored, {
        employeeId: "emp-a",
        picks: [{ detailId: "det-1", kind: "torcev", quantity: 4 }],
      }),
    ).toBe("CONFLICT");
    expect(
      decidePrisadkaReplay(stored, {
        employeeId: "emp-a",
        picks: [{ detailId: "det-1", kind: "plosk", quantity: 3 }],
      }),
    ).toBe("CONFLICT");
    expect(
      decidePrisadkaReplay(
        {
          ...stored,
          lines: [
            {
              detailId: null,
              quantity: 3,
              prisadkaTorcevaya: true,
              prisadkaPloskost: false,
            },
          ],
        },
        { employeeId: "emp-a", picks: [{ detailId: "det-1", kind: "torcev", quantity: 3 }] },
      ),
    ).toBe("CONFLICT");
    expect(
      decidePrisadkaReplay(stored, {
        employeeId: "emp-b",
        picks: [{ detailId: "det-1", kind: "torcev", quantity: 3 }],
      }),
    ).toBe("CONFLICT");
  });

  it("matches upakovka only when the whole product set and quantities match", () => {
    const parentRequestId = "req-1";
    const stored = [
      {
        employeeId: "emp-a",
        type: "UPAKOVKA",
        productId: "prod-a",
        productQty: 1,
        clientRequestId: "req-1:prod-a",
      },
      {
        employeeId: "emp-a",
        type: "UPAKOVKA",
        productId: "prod-b",
        productQty: 2,
        clientRequestId: "req-1:prod-b",
      },
    ];
    const full = {
      employeeId: "emp-a",
      parentRequestId,
      picks: [
        { productId: "prod-b", quantity: 2 },
        { productId: "prod-a", quantity: 1 },
      ],
    };
    expect(decideUpakovkaReplay(stored, full)).toBe("MATCH");
    expect(
      decideUpakovkaReplay(stored, {
        ...full,
        picks: [
          { productId: "prod-a", quantity: 2 },
          { productId: "prod-b", quantity: 2 },
        ],
      }),
    ).toBe("CONFLICT");
    expect(
      decideUpakovkaReplay(stored, {
        ...full,
        picks: [{ productId: "prod-a", quantity: 1 }],
      }),
    ).toBe("CONFLICT");
    expect(
      decideUpakovkaReplay([stored[0]!], {
        ...full,
        picks: [
          { productId: "prod-a", quantity: 1 },
          { productId: "prod-b", quantity: 2 },
        ],
      }),
    ).toBe("PARTIAL");
    expect(decideUpakovkaReplay(stored, { ...full, employeeId: "emp-b" })).toBe("CONFLICT");
    expect(
      decideUpakovkaReplay(
        [{ ...stored[0]!, productId: null, productQty: 1 }],
        { ...full, picks: [{ productId: "prod-a", quantity: 1 }] },
      ),
    ).toBe("CONFLICT");
  });

  it("allows a new upakovka only for products the employee confirmed as unrecorded", () => {
    const stored = [
      {
        employeeId: "emp-a",
        type: "UPAKOVKA",
        productId: "prod-a",
        productQty: 1,
        clientRequestId: "req-1:prod-a",
      },
    ];
    expect(
      guardConfirmedUnrecorded(stored, {
        employeeId: "emp-a",
        recordedRequestId: "req-1",
        parentRequestId: "req-2",
        picks: [{ productId: "prod-b", quantity: 2 }],
      }),
    ).toBe("OK");
    expect(
      guardConfirmedUnrecorded(stored, {
        employeeId: "emp-a",
        recordedRequestId: "req-1",
        parentRequestId: "req-2",
        picks: [{ productId: "prod-a", quantity: 1 }],
      }),
    ).toBe("ALREADY_RECORDED");
    expect(
      guardConfirmedUnrecorded(stored, {
        employeeId: "emp-b",
        recordedRequestId: "req-1",
        parentRequestId: "req-2",
        picks: [{ productId: "prod-b", quantity: 2 }],
      }),
    ).toBe("CONFLICT");
    expect(UPAKOVKA_ALREADY_RECORDED).not.toMatch(/сотрудник|работник|другому/i);
  });

  it("matches hours only for the same employee and the exact hour count", () => {
    const stored = {
      employeeId: "emp-a",
      type: "HOURS",
      hours: new Prisma.Decimal("8.50"),
    };
    expect(decideHoursReplay(stored, { employeeId: "emp-a", hours: 8.5 })).toBe("MATCH");
    expect(decideHoursReplay(stored, { employeeId: "emp-a", hours: 8 })).toBe("CONFLICT");
    expect(decideHoursReplay(stored, { employeeId: "emp-b", hours: 8.5 })).toBe("CONFLICT");
    expect(decideHoursReplay({ ...stored, hours: null }, { employeeId: "emp-a", hours: 8.5 })).toBe(
      "CONFLICT",
    );
    expect(decideHoursReplay({ ...stored, type: "PRISADKA" }, { employeeId: "emp-a", hours: 8.5 })).toBe(
      "CONFLICT",
    );
  });
});
