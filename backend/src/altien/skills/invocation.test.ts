import { describe, expect, it } from "vitest";
import { parseExplicitSkillInvocation } from "./invocation";

describe("explicit skill invocation", () => {
  it("accepts slash syntax and quoted verb syntax", () => {
    expect(parseExplicitSkillInvocation("/skill Citation Reader\nCheck this.")).toBe(
      "Citation Reader",
    );
    expect(parseExplicitSkillInvocation('use skill "Citation Reader" to check this')).toBe(
      "Citation Reader",
    );
    expect(parseExplicitSkillInvocation('load skill “Citation Reader”')).toBe(
      "Citation Reader",
    );
  });

  it("never infers a skill from ordinary chat language", () => {
    expect(
      parseExplicitSkillInvocation(
        "Could you use the citation reader skill to check this?",
      ),
    ).toBeNull();
    expect(parseExplicitSkillInvocation("use skill Citation Reader")).toBeNull();
  });
});

