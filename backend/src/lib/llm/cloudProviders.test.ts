import { describe, expect, it } from "vitest";
import {
  azureClientTarget,
  normalizeAwsRegion,
  normalizeAzureEndpoint,
} from "./cloudProviders";

describe("normalizeAwsRegion", () => {
  it.each([
    ["us-east-1", "us-east-1"],
    [" EU-Central-2 ", "eu-central-2"],
    ["us-gov-west-1", "us-gov-west-1"],
    ["ap-southeast-5", "ap-southeast-5"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeAwsRegion(input)).toBe(expected);
  });

  it.each(["", "us-east", "useast1", "us-east-1.evil.com", "us east 1", null, 1])(
    "rejects %j",
    (input) => {
      expect(normalizeAwsRegion(input)).toBeNull();
    },
  );
});

describe("normalizeAzureEndpoint", () => {
  it.each([
    ["Contoso-OpenAI", "contoso-openai"],
    [
      "https://contoso.openai.azure.com/",
      "https://contoso.openai.azure.com",
    ],
    [
      "https://contoso.openai.azure.com/openai/v1/",
      "https://contoso.openai.azure.com/openai/v1",
    ],
    [
      "https://contoso.cognitiveservices.azure.com",
      "https://contoso.cognitiveservices.azure.com",
    ],
    [
      "https://contoso.services.ai.azure.com/api/projects/legal",
      "https://contoso.services.ai.azure.com/api/projects/legal",
    ],
  ])("accepts %j", (input, expected) => {
    expect(normalizeAzureEndpoint(input)).toBe(expected);
  });

  it.each([
    "",
    "http://contoso.openai.azure.com",
    "https://attacker.example",
    "https://openai.azure.com",
    "https://contoso.openai.azure.com.attacker.example",
    "https://user:pass@contoso.openai.azure.com",
    "https://contoso.openai.azure.com:8443",
    "https://contoso.openai.azure.com/openai?x=1",
    "https://169.254.169.254/openai",
    "-leading-hyphen",
  ])("rejects %j", (input) => {
    expect(normalizeAzureEndpoint(input)).toBeNull();
  });
});

describe("azureClientTarget", () => {
  it("passes a resource name through", () => {
    expect(azureClientTarget("contoso-openai")).toEqual({
      resourceName: "contoso-openai",
    });
  });

  it("adds the /openai path to a bare host", () => {
    expect(azureClientTarget("https://contoso.cognitiveservices.azure.com")).toEqual({
      baseURL: "https://contoso.cognitiveservices.azure.com/openai",
    });
  });

  it("keeps an explicit path", () => {
    expect(
      azureClientTarget("https://contoso.services.ai.azure.com/api/projects/legal"),
    ).toEqual({
      baseURL: "https://contoso.services.ai.azure.com/api/projects/legal",
    });
  });
});
