import { describe, expect, it } from "vitest";
import {
  LIKELY_SIDE_NOTE,
  OPENING_VOLUME_SHARE,
  classifyOpening,
  formatOptionPrice,
  formatSpread,
  openingLabel,
  quoteFacts,
} from "@/app/lib/quoteSide";

describe("quote and likely side", () => {
  it("shows bid, ask, last, mid, and spread from the quote, and leaves a missing last blank", () => {
    const full = quoteFacts({ bid: 2, ask: 2.1, last: 2.1 });
    expect(full.bid).toBe(2);
    expect(full.ask).toBe(2.1);
    expect(full.last).toBe(2.1);
    expect(full.mid).toBeCloseTo(2.05);
    expect(full.spread).toBeCloseTo(0.1);
    expect(formatOptionPrice(full.bid)).toBe("$2.00");
    expect(formatSpread(full.spread, full.spreadFraction)).toBe("$0.10 · 4.9% of mid");
    expect(full.likelySide).toBe("buyers");
    expect(full.likelySideLabel).toBe("Buyers paying up");
    expect(full.note).toBe(LIKELY_SIDE_NOTE);
    expect(full.note).toMatch(/not a trade print/i);

    const missing = quoteFacts({ bid: 2, ask: 2.1, last: Number.NaN });
    expect(missing.last).toBeNull();
    expect(missing.likelySide).toBe("unknown");
    expect(formatOptionPrice(missing.last)).toBe("—");
    expect(quoteFacts({ bid: Number.NaN, ask: 2, last: 2 }).mid).toBeNull();
    expect(formatSpread(null, null)).toBe("—");
  });

  it("calls a last price near the ask buyers, near the bid sellers, and the middle unclear", () => {
    expect(quoteFacts({ bid: 1, ask: 2, last: 1.7 }).likelySide).toBe("buyers");
    expect(quoteFacts({ bid: 1, ask: 2, last: 1.3 }).likelySide).toBe("sellers");
    expect(quoteFacts({ bid: 1, ask: 2, last: 1.5 }).likelySide).toBe("unclear");
    expect(quoteFacts({ bid: 1, ask: 2, last: 1.5 }).likelySideLabel).toBe("Unclear");
  });
});

describe("opening classification", () => {
  it("treats a large rise as opening and a flat or smaller rise as closing", () => {
    expect(OPENING_VOLUME_SHARE).toBe(0.5);
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 400, nextOpenInterest: 1200 })).toBe("opening");
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 400, nextOpenInterest: 1200 })).toBe("opening");
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 400, nextOpenInterest: 1199 })).toBe("closing");
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 400, nextOpenInterest: 1000 })).toBe("closing");
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 400, nextOpenInterest: 900 })).toBe("closing");
    expect(openingLabel("opening")).toBe("Opening confirmed");
    expect(openingLabel("closing")).toBe("Likely closing");
    expect(openingLabel("pending")).toBe("Pending (checks tomorrow)");
  });

  it("does not invent a side of the open when a number is missing", () => {
    expect(classifyOpening({ priorOpenInterest: null, volume: 400, nextOpenInterest: 1200 })).toBeNull();
    expect(classifyOpening({ priorOpenInterest: 1000, volume: null, nextOpenInterest: 1200 })).toBeNull();
    expect(classifyOpening({ priorOpenInterest: 1000, volume: 0, nextOpenInterest: 1200 })).toBeNull();
    expect(classifyOpening({ priorOpenInterest: 1000, volume: null, nextOpenInterest: 1000 })).toBe("closing");
  });
});
