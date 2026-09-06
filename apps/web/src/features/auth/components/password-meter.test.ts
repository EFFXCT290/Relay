import { describe, it, expect } from "vitest";
import { score } from "./password-meter";

// Table-driven against the ACTUAL thresholds read from score()'s source
// (MIN_LENGTH=12; tier 4 needs length>=20 AND variety>=3; tier 3 needs
// variety>=2 regardless of length past the 12-char floor; tier 2 is
// length>=12 with variety<2), not an assumed tier count or boundary.
//
// One thing worth noting for whoever next touches this function: the
// `length>=16 && variety>=2` branch is fully subsumed by the very next
// `variety>=2` branch (identical tier/label output) — it can never be the
// branch that decides the outcome, since anything matching it also matches
// the one after. Not a behavior bug (verified below: output is correct and
// consistent either way), just dead-in-effect logic, likely a leftover from
// an earlier tier design.

describe("score() — tier boundaries", () => {
  it("empty password: tier 0, no label", () => {
    expect(score("")).toEqual({ tier: 0, label: "—", color: "var(--color-text-muted)" });
  });

  it("below the 12-char floor: tier 1, counts down exactly how many more characters are needed", () => {
    expect(score("abc")).toMatchObject({ tier: 1, label: "9 more" }); // 12-3
    const eleven = "a".repeat(11);
    expect(eleven).toHaveLength(11);
    expect(score(eleven)).toMatchObject({ tier: 1, label: "1 more" });
  });

  it("exactly at the 12-char floor with low variety (1 class): tier 2 'Fair'", () => {
    const twelveLower = "a".repeat(12);
    expect(twelveLower).toHaveLength(12);
    expect(score(twelveLower)).toMatchObject({ tier: 2, label: "Fair" });
  });

  it("long but still only 1 character class: length alone does NOT overcome low variety — still tier 2 'Fair'", () => {
    const longLowerOnly = "a".repeat(25);
    expect(score(longLowerOnly)).toMatchObject({ tier: 2, label: "Fair" });
  });

  it("length>=12 with exactly 2 character classes: tier 3 'Strong', even well below 16 or 20 chars", () => {
    const twelveTwoClasses = "aaaaaaaaaaaA"; // lower + upper, length 12
    expect(twelveTwoClasses).toHaveLength(12);
    expect(score(twelveTwoClasses)).toMatchObject({ tier: 3, label: "Strong" });
  });

  it("length>=20 with only 2 character classes: still tier 3 'Strong', NOT 'Excellent' — variety>=3 is required too", () => {
    const twentyTwoClasses = "a".repeat(19) + "1"; // lower + digit, length 20
    expect(twentyTwoClasses).toHaveLength(20);
    expect(score(twentyTwoClasses)).toMatchObject({ tier: 3, label: "Strong" });
  });

  it("length 19 (just under the tier-4 floor) with ALL 4 character classes: still tier 3 'Strong' — length is a hard requirement, not variety alone", () => {
    const nineteenAllClasses = "a".repeat(15) + "A1!" + "b"; // lower+upper+digit+symbol, length 19
    expect(nineteenAllClasses).toHaveLength(19);
    expect(score(nineteenAllClasses)).toMatchObject({ tier: 3, label: "Strong" });
  });

  it("length>=20 AND variety>=3: tier 4 'Excellent'", () => {
    const twentyThreeClasses = "a".repeat(17) + "A11"; // lower+upper+digit, length 20
    expect(twentyThreeClasses).toHaveLength(20);
    expect(score(twentyThreeClasses)).toMatchObject({ tier: 4, label: "Excellent" });
  });

  it("well past every threshold with all 4 character classes: tier 4 'Excellent'", () => {
    const overkill = "a".repeat(20) + "A1!";
    expect(score(overkill)).toMatchObject({ tier: 4, label: "Excellent" });
  });
});
