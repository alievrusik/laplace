import assert from "node:assert/strict";
import { defaultRuntimePolicy } from "../orchestrator/agentContracts.js";

export function runModelPolicyCheck(): void {
  const policy = defaultRuntimePolicy({
    briefModel: "brief-model",
    skepticModel: "skeptic-model",
    builderModel: "builder-model",
    testerModel: "tester-model",
    revisorModel: "revisor-model",
    estimatorModel: "estimator-model",
  });

  const byRole = new Map(policy.map((item) => [item.role, item]));
  assert.equal(byRole.get("agent_brief")?.modelId, "brief-model");
  assert.equal(byRole.get("agent_skeptic")?.modelId, "skeptic-model");
  assert.equal(byRole.get("agent_builder")?.modelId, "builder-model");
  assert.equal(byRole.get("agent_tester")?.modelId, "tester-model");
  assert.equal(byRole.get("agent_revisor")?.modelId, "revisor-model");
  assert.equal(byRole.get("agent_estimator")?.modelId, "estimator-model");
  for (const item of policy) {
    assert.equal(item.reasoningEnabled, true, `${item.role} should have reasoning enabled`);
  }
}
