import path from "node:path";
import { runSurveyRegressionChecks } from "./regressionScenarios.js";

async function main() {
  await runSurveyRegressionChecks({
    memoryDir: path.resolve("laplace-memory"),
    surveyPath: path.resolve("GenAI_Client_Survey_Final.xlsx"),
  });
  console.log("Regression scenarios passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
