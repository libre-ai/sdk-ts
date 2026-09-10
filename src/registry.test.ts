import { describe, expect, test } from "bun:test";
import {
  ContractNotFoundError,
  ContractValidationError,
  loadCanonicalContractRegistry,
} from "./registry";

type JsonRecord = Record<string, unknown>;
type Mutation = { name: string; path: string; value?: unknown; remove?: boolean };
type Fixture = { schema: string; valid: JsonRecord; invalidMutations: Mutation[] };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutate(input: JsonRecord, mutation: Mutation): JsonRecord {
  const output = structuredClone(input);
  const segments = mutation.path
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let target: unknown = output;
  for (const segment of segments.slice(0, -1)) {
    if ((!isRecord(target) && !Array.isArray(target)) || !(segment in target)) {
      throw new Error(`Unknown fixture mutation path: ${mutation.path}`);
    }
    target = target[segment as keyof typeof target];
  }
  const key = segments.at(-1);
  if (!key || (!isRecord(target) && !Array.isArray(target))) {
    throw new Error(`Invalid fixture mutation path: ${mutation.path}`);
  }
  if (mutation.remove) {
    if (Array.isArray(target)) target.splice(Number(key), 1);
    else delete target[key];
  } else {
    target[key as keyof typeof target] = mutation.value as never;
  }
  return output;
}

const registry = await loadCanonicalContractRegistry();
const authorizedExecutionSchemaNames = [
  "effect-attestation.v1.schema.json",
  "execution-authorization.v2.schema.json",
  "execution-graph.v1.schema.json",
  "execution-plan-body.v2.schema.json",
  "execution-transfer.v1.schema.json",
  "human-decision-request.v1.schema.json",
  "human-decision-response.v1.schema.json",
  "orchestrator-event.v3.schema.json",
  "retention-policy.v2.schema.json",
  "step-invocation.v1.schema.json",
] as const;
const fixtureDocument = (await Bun.file(
  "node_modules/@libre-ai/contracts-authority/contracts/fixtures/schema-fixtures.v1.json",
).json()) as {
  cases: Fixture[];
};

describe("canonical contract registry", () => {
  test("includes every authorized execution candidate schema", () => {
    expect(registry.schemaNames()).toEqual(expect.arrayContaining(authorizedExecutionSchemaNames));
  });

  test("validates the authorized execution retention v2 authority data", async () => {
    const retention = await Bun.file(
      "node_modules/@libre-ai/contracts-authority/contracts/data/retention.v2.json",
    ).json();
    expect(registry.validate("retention-policy.v2.schema.json", retention)).toEqual({
      ok: true,
      value: retention,
    });
  });

  test("compiles every canonical JSON Schema without network retrieval", () => {
    expect(registry.schemaNames()).toHaveLength(fixtureDocument.cases.length + 1);
    expect(registry.schemaNames()).toContain("common.v1.schema.json");
  });

  for (const fixture of fixtureDocument.cases) {
    test(`${fixture.schema} accepts its canonical fixture`, () => {
      expect(registry.validate(fixture.schema, fixture.valid)).toEqual({
        ok: true,
        value: fixture.valid,
      });
    });

    test(`${fixture.schema} rejects malformed, unknown and domain-negative inputs`, () => {
      expect(registry.validate(fixture.schema, null).ok).toBeFalse();
      expect(
        registry.validate(fixture.schema, { ...fixture.valid, __unexpected: true }).ok,
      ).toBeFalse();
      if (typeof fixture.valid.schemaVersion === "string") {
        expect(
          registry.validate(fixture.schema, {
            ...fixture.valid,
            schemaVersion: "libre-ai.unknown.v999",
          }).ok,
        ).toBeFalse();
      }
      for (const mutation of fixture.invalidMutations) {
        expect(registry.validate(fixture.schema, mutate(fixture.valid, mutation)).ok).toBeFalse();
      }
    });
  }

  test("never includes rejected private values in validation issues", () => {
    const privateValue = "private-value-must-not-leak";
    const result = registry.validate("browser-session.v1.schema.json", {
      sessionDigest: privateValue,
    });
    expect(result.ok).toBeFalse();
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  test("fails closed for an unknown contract", () => {
    expect(() => registry.validate("missing.schema.json", {})).toThrow(ContractNotFoundError);
  });

  test("assert exposes only safe issues", () => {
    expect(() => registry.assert("problem-details.v1.schema.json", {})).toThrow(
      ContractValidationError,
    );
  });
});
