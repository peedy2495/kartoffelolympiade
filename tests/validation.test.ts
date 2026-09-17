import { describe, expect, it } from "vitest";
import {
  formatTenthsToGerman,
  isAgeGroup,
  parseTimeInputToTenths,
  validateName,
  validateStoredValue,
} from "../src/lib/validation.js";

describe("validateName", () => {
  it("trims and accepts normal names", () => {
    expect(validateName("  Lina  Meyer ")).toBe("Lina Meyer");
  });
  it("rejects empty and too-long names", () => {
    expect(validateName("   ")).toBeNull();
    expect(validateName("")).toBeNull();
    expect(validateName("x".repeat(101))).toBeNull();
    expect(validateName("x".repeat(100))).toBe("x".repeat(100));
  });
  it("rejects non-strings", () => {
    expect(validateName(42)).toBeNull();
    expect(validateName(null)).toBeNull();
  });
});

describe("age enum boundaries", () => {
  it("accepts only the two enum values", () => {
    expect(isAgeGroup("up_to_14")).toBe(true);
    expect(isAgeGroup("over_14")).toBe(true);
    expect(isAgeGroup("u14")).toBe(false);
    expect(isAgeGroup("")).toBe(false);
    expect(isAgeGroup(undefined)).toBe(false);
  });
});

describe("stored values", () => {
  it("golf requires positive integer", () => {
    expect(validateStoredValue("golf", 1)).toBe(true);
    expect(validateStoredValue("golf", 0)).toBe(false);
    expect(validateStoredValue("golf", -3)).toBe(false);
    expect(validateStoredValue("golf", 1.5)).toBe(false);
  });
  it("throwing allows zero but no negatives", () => {
    expect(validateStoredValue("throwing", 0)).toBe(true);
    expect(validateStoredValue("throwing", 7)).toBe(true);
    expect(validateStoredValue("throwing", -1)).toBe(false);
  });
  it("times require positive tenths", () => {
    expect(validateStoredValue("obstacle", 0)).toBe(false);
    expect(validateStoredValue("obstacle", 123)).toBe(true);
    expect(validateStoredValue("peeling", 1)).toBe(true);
  });
  it("bounds integers at 1e6", () => {
    expect(validateStoredValue("golf", 1_000_000)).toBe(true);
    expect(validateStoredValue("golf", 1_000_001)).toBe(false);
  });
});

describe("time parsing", () => {
  it("accepts comma and dot with one decimal", () => {
    expect(parseTimeInputToTenths("12,3")).toEqual({ ok: true, tenths: 123 });
    expect(parseTimeInputToTenths("12.3")).toEqual({ ok: true, tenths: 123 });
    expect(parseTimeInputToTenths("9")).toEqual({ ok: true, tenths: 90 });
  });
  it("rejects two decimals, zero, garbage", () => {
    expect(parseTimeInputToTenths("12,34").ok).toBe(false);
    expect(parseTimeInputToTenths("0").ok).toBe(false);
    expect(parseTimeInputToTenths("0,0").ok).toBe(false);
    expect(parseTimeInputToTenths("abc").ok).toBe(false);
    expect(parseTimeInputToTenths("12,,3").ok).toBe(false);
  });
  it("blank means missing", () => {
    expect(parseTimeInputToTenths("").tenths).toBeNull();
    expect(parseTimeInputToTenths("   ").tenths).toBeNull();
  });
  it("formats German one decimal", () => {
    expect(formatTenthsToGerman(123)).toBe("12,3");
    expect(formatTenthsToGerman(90)).toBe("9,0");
  });
});
