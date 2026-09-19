import { describe, expect, it } from "vitest";
import {
  ERROR_DEDUCTION_TENTHS,
  effectiveRunTenths,
  formatDurationTenths,
  tenthsFromMillis,
} from "../src/lib/time.js";

describe("formatDurationTenths", () => {
  it("shows seconds and tenths only for sub-minute durations", () => {
    expect(formatDurationTenths(0)).toBe("0,0 s");
    expect(formatDurationTenths(123)).toBe("12,3 s");
    expect(formatDurationTenths(599)).toBe("59,9 s");
  });

  it("shows minutes with padded inner seconds at the minute boundary", () => {
    expect(formatDurationTenths(600)).toBe("1 min 00,0 s");
    expect(formatDurationTenths(1234)).toBe("2 min 03,4 s");
    expect(formatDurationTenths(35999)).toBe("59 min 59,9 s");
  });

  it("shows hours with padded minutes and seconds, retaining inner zero fields", () => {
    expect(formatDurationTenths(36000)).toBe("1 h 00 min 00,0 s");
    expect(formatDurationTenths(37234)).toBe("1 h 02 min 03,4 s");
  });

  it("renders a leading minus on the whole duration for negative input", () => {
    expect(formatDurationTenths(-123)).toBe("-12,3 s");
    expect(formatDurationTenths(-600)).toBe("-1 min 00,0 s");
    expect(formatDurationTenths(-37234)).toBe("-1 h 02 min 03,4 s");
  });
});

describe("tenthsFromMillis", () => {
  it("floors milliseconds to tenths", () => {
    expect(tenthsFromMillis(0)).toBe(0);
    expect(tenthsFromMillis(123)).toBe(1);
    expect(tenthsFromMillis(1234)).toBe(12);
    expect(tenthsFromMillis(61500)).toBe(615);
  });
});

describe("effectiveRunTenths", () => {
  it("keeps the raw time with zero errors", () => {
    expect(effectiveRunTenths(123)).toBe(123);
    expect(effectiveRunTenths(123, 0)).toBe(123);
  });

  it("subtracts 3 s (30 tenths) per error with integer arithmetic", () => {
    expect(ERROR_DEDUCTION_TENTHS).toBe(30);
    expect(effectiveRunTenths(123, 2)).toBe(63);
    expect(effectiveRunTenths(123, 1)).toBe(93);
    expect(effectiveRunTenths(600, 3)).toBe(510);
  });

  it("allows zero and negative effective times", () => {
    expect(effectiveRunTenths(30, 1)).toBe(0);
    expect(effectiveRunTenths(29, 1)).toBe(-1);
    expect(effectiveRunTenths(123, 5)).toBe(-27);
  });
});