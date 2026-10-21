import { expect, test } from "bun:test"
import { normalizeStepNumericExponents } from "../lib/step-text-utils"

test("normalizes STEP exponents without changing quoted strings", () => {
  const stepText = [
    "#1 = CARTESIAN_POINT('',(1e-3,2.5e+4,3e5));",
    "#2 = PRODUCT('sensor1e-10','sensor1e-10','',(#3));",
    "#3 = DESCRIPTIVE_REPRESENTATION_ITEM('it''s 1e-3','');",
  ].join("\n")

  expect(normalizeStepNumericExponents(stepText)).toBe(
    [
      "#1 = CARTESIAN_POINT('',(1E-3,2.5E+4,3E5));",
      "#2 = PRODUCT('sensor1e-10','sensor1e-10','',(#3));",
      "#3 = DESCRIPTIVE_REPRESENTATION_ITEM('it''s 1e-3','');",
    ].join("\n"),
  )
})
