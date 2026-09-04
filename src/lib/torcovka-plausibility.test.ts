import { describe, expect, it } from "vitest";
import { D } from "@/lib/cost";
import {
  bandFromWastePct,
  canonicalProducedM,
  canonicalTakenM,
  canonicalWastePct,
  computeTorcovkaWasteMetrics,
  decideTorcovkaSubmit,
  type TorcovkaPlausibilityAck,
} from "./torcovka-plausibility";

function metricsForWaste(opts: {
  railsTaken: number;
  lotLengthM: string;
  producedQty: number;
  blankLengthM: string;
}) {
  return computeTorcovkaWasteMetrics(opts.railsTaken, opts.lotLengthM, [
    { lengthM: opts.blankLengthM, quantity: opts.producedQty },
  ]);
}

/** 10% waste, INV-008 holds: taken 10 м, produced 9 м. */
function waste10() {
  return metricsForWaste({
    railsTaken: 5,
    lotLengthM: "2",
    producedQty: 9,
    blankLengthM: "1",
  });
}

/** 30% waste: taken 10 м, produced 7 м. */
function waste30() {
  return metricsForWaste({
    railsTaken: 5,
    lotLengthM: "2",
    producedQty: 7,
    blankLengthM: "1",
  });
}

/** 73% waste: taken 100 м, produced 27 м. */
function waste73() {
  return metricsForWaste({
    railsTaken: 10,
    lotLengthM: "10",
    producedQty: 27,
    blankLengthM: "1",
  });
}

describe("canonical strings", () => {
  it("takenM and producedM are 4dp, wastePct is 2dp", () => {
    const m = waste10();
    expect(m.canon.takenM).toBe("10.0000");
    expect(m.canon.producedM).toBe("9.0000");
    expect(m.canon.wastePct).toBe("10.00");
    expect(canonicalTakenM(m.takenM)).toBe("10.0000");
    expect(canonicalProducedM(m.producedM)).toBe("9.0000");
    expect(canonicalWastePct(m.wastePct)).toBe("10.00");
  });
});

describe("bandFromWastePct", () => {
  it("19.99 → NORMAL, 20 → SUSPICIOUS, 49.99 → SUSPICIOUS, 50 → EXTREME", () => {
    expect(bandFromWastePct(D("19.99"))).toBe("NORMAL");
    expect(bandFromWastePct(D("20"))).toBe("SUSPICIOUS");
    expect(bandFromWastePct(D("49.99"))).toBe("SUSPICIOUS");
    expect(bandFromWastePct(D("50"))).toBe("EXTREME");
  });

  it("raw 19.994... → NORMAL; raw 19.995... → rounded 20.00 → SUSPICIOUS", () => {
    expect(bandFromWastePct(D("19.994"))).toBe("NORMAL");
    expect(canonicalWastePct(D("19.994"))).toBe("19.99");
    expect(bandFromWastePct(D("19.995"))).toBe("SUSPICIOUS");
    expect(canonicalWastePct(D("19.995"))).toBe("20.00");
  });

  it("raw 49.994... → SUSPICIOUS; raw 49.995... → rounded 50.00 → EXTREME", () => {
    expect(bandFromWastePct(D("49.994"))).toBe("SUSPICIOUS");
    expect(canonicalWastePct(D("49.994"))).toBe("49.99");
    expect(bandFromWastePct(D("49.995"))).toBe("EXTREME");
    expect(canonicalWastePct(D("49.995"))).toBe("50.00");
  });
});

describe("§13 matrix 1–6", () => {
  it("1: waste 10%, no ack → CREATED; submit fields null", () => {
    const m = waste10();
    expect(m.band).toBe("NORMAL");
    const decision = decideTorcovkaSubmit({ railsTaken: 5, metrics: m });
    expect(decision).toEqual({
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: null,
        torcovkaSubmitWasteReason: null,
        torcovkaSubmitWasteNote: null,
      },
    });
  });

  it("2: waste 30%, no ack → ACK_REQUIRED SUSPICIOUS with 4dp/2dp strings", () => {
    const m = waste30();
    expect(m.band).toBe("SUSPICIOUS");
    const decision = decideTorcovkaSubmit({ railsTaken: 5, metrics: m });
    expect(decision).toEqual({
      status: "ACK_REQUIRED",
      band: "SUSPICIOUS",
      railsTaken: 5,
      takenM: "10.0000",
      producedM: "7.0000",
      wastePct: "30.00",
    });
  });

  it("3: waste 30% + ack SUSPICIOUS echoing canonical strings → CREATED SUSPICIOUS", () => {
    const m = waste30();
    const ack: TorcovkaPlausibilityAck = {
      kind: "SUSPICIOUS",
      railsTaken: 5,
      takenM: m.canon.takenM,
      producedM: m.canon.producedM,
      wastePct: m.canon.wastePct,
    };
    const decision = decideTorcovkaSubmit({ railsTaken: 5, metrics: m, ack });
    expect(decision).toEqual({
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: "SUSPICIOUS",
        torcovkaSubmitWasteReason: null,
        torcovkaSubmitWasteNote: null,
      },
    });
  });

  it("4: waste 73%, no ack → ACK_REQUIRED EXTREME; SUSPICIOUS ack throws", () => {
    const m = waste73();
    expect(m.band).toBe("EXTREME");
    expect(m.canon.wastePct).toBe("73.00");
    const first = decideTorcovkaSubmit({ railsTaken: 10, metrics: m });
    expect(first).toEqual({
      status: "ACK_REQUIRED",
      band: "EXTREME",
      railsTaken: 10,
      takenM: "100.0000",
      producedM: "27.0000",
      wastePct: "73.00",
    });
    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 10,
        metrics: m,
        ack: {
          kind: "SUSPICIOUS",
          railsTaken: 10,
          takenM: m.canon.takenM,
          producedM: m.canon.producedM,
          wastePct: m.canon.wastePct,
        },
      }),
    ).toThrow();
  });

  it("5: waste 73% + HIGH_WASTE + KNOTS + echo → CREATED HIGH_WASTE reason persisted", () => {
    const m = waste73();
    const decision = decideTorcovkaSubmit({
      railsTaken: 10,
      metrics: m,
      ack: {
        kind: "HIGH_WASTE",
        railsTaken: 10,
        takenM: m.canon.takenM,
        producedM: m.canon.producedM,
        wastePct: m.canon.wastePct,
        reason: "KNOTS",
      },
    });
    expect(decision).toEqual({
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: "HIGH_WASTE",
        torcovkaSubmitWasteReason: "KNOTS",
        torcovkaSubmitWasteNote: null,
      },
    });
  });

  it("6: confirmed:true / float metrics / mismatched strings do not CREATED", () => {
    const m = waste73();
    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 10,
        metrics: m,
        ack: { confirmed: true } as unknown as TorcovkaPlausibilityAck,
      }),
    ).toThrow();

    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 10,
        metrics: m,
        ack: {
          kind: "HIGH_WASTE",
          railsTaken: 10,
          takenM: 100 as unknown as string,
          producedM: m.canon.producedM,
          wastePct: m.canon.wastePct,
          reason: "KNOTS",
        },
      }),
    ).toThrow();

    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 10,
        metrics: m,
        ack: {
          kind: "HIGH_WASTE",
          railsTaken: 10,
          takenM: "100.0001",
          producedM: m.canon.producedM,
          wastePct: m.canon.wastePct,
          reason: "KNOTS",
        },
      }),
    ).toThrow();

    const noAck = decideTorcovkaSubmit({ railsTaken: 10, metrics: m });
    expect(noAck.status).toBe("ACK_REQUIRED");
  });

  it("OTHER requires nonempty trimmed note", () => {
    const m = waste73();
    const base = {
      kind: "HIGH_WASTE" as const,
      railsTaken: 10,
      takenM: m.canon.takenM,
      producedM: m.canon.producedM,
      wastePct: m.canon.wastePct,
      reason: "OTHER" as const,
    };
    expect(() => decideTorcovkaSubmit({ railsTaken: 10, metrics: m, ack: base })).toThrow();
    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 10,
        metrics: m,
        ack: { ...base, reasonNote: "   " },
      }),
    ).toThrow();
    const ok = decideTorcovkaSubmit({
      railsTaken: 10,
      metrics: m,
      ack: { ...base, reasonNote: "  кривая партия  " },
    });
    expect(ok).toEqual({
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: "HIGH_WASTE",
        torcovkaSubmitWasteReason: "OTHER",
        torcovkaSubmitWasteNote: "кривая партия",
      },
    });
  });

  it("NORMAL with ack present throws", () => {
    const m = waste10();
    expect(() =>
      decideTorcovkaSubmit({
        railsTaken: 5,
        metrics: m,
        ack: {
          kind: "SUSPICIOUS",
          railsTaken: 5,
          takenM: m.canon.takenM,
          producedM: m.canon.producedM,
          wastePct: m.canon.wastePct,
        },
      }),
    ).toThrow();
  });
});
