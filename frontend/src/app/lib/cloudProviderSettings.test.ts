import { describe, expect, it } from "vitest";
import {
  normalizeAwsRegion,
  normalizeAzureEndpoint,
} from "./cloudProviderSettings";

describe("normalizeAwsRegion", () => {
  it("accepts region codes in any case", () => {
    expect(normalizeAwsRegion(" EU-West-2 ")).toBe("eu-west-2");
    expect(normalizeAwsRegion("us-gov-west-1")).toBe("us-gov-west-1");
  });

  it("rejects anything that is not a region code", () => {
    for (const value of ["", "us-east", "London", "us-east-1.example.com"]) {
      expect(normalizeAwsRegion(value)).toBeNull();
    }
  });
});

describe("normalizeAzureEndpoint", () => {
  it("accepts a resource name or an Azure AI endpoint", () => {
    expect(normalizeAzureEndpoint("Contoso-OpenAI")).toBe("contoso-openai");
    expect(
      normalizeAzureEndpoint("https://contoso.openai.azure.com/"),
    ).toBe("https://contoso.openai.azure.com");
    expect(
      normalizeAzureEndpoint(
        "https://contoso.services.ai.azure.com/api/projects/legal",
      ),
    ).toBe("https://contoso.services.ai.azure.com/api/projects/legal");
  });

  it("rejects non-Azure hosts, plain http and decorated URLs", () => {
    for (const value of [
      "https://example.com",
      "http://contoso.openai.azure.com",
      "https://contoso.openai.azure.com.example.com",
      "https://contoso.openai.azure.com/?key=1",
    ]) {
      expect(normalizeAzureEndpoint(value)).toBeNull();
    }
  });
});
