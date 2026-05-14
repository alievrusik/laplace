import { createMockOssRuntime, runRuntimeCompatibilityHarness } from "./runtimeAdapterHarness.js";
import { runModelPolicyCheck } from "./modelPolicyCheck.js";

async function main() {
  const runtime = createMockOssRuntime();
  await runRuntimeCompatibilityHarness(runtime);
  runModelPolicyCheck();
  console.log("Runtime compatibility harness passed for mock OSS adapter.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
