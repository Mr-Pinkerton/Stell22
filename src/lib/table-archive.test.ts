import { describe, expect, it } from "vitest";
import { partitionActiveArchived } from "@/lib/table-archive";

describe("partitionActiveArchived", () => {
  it("переносит архивные записи вниз, сохраняя порядок внутри групп", () => {
    const rows = [
      { id: "1", archived: true },
      { id: "2", archived: false },
      { id: "3", archived: true },
      { id: "4", archived: false },
    ];
    const result = partitionActiveArchived(rows, (r) => r.archived);
    expect(result.map((r) => r.id)).toEqual(["2", "4", "1", "3"]);
  });
});
