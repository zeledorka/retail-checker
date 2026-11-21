// LIVE (billed) and NOT run by the test suite: generates a batch of cases with Claude and prints them as JSON.
//   cd scenarios && ANTHROPIC_API_KEY=... npx tsx scripts/generate-live.ts 6 12345
// Review the output, then add accepted cases to a pool (they are validated here, not curated). No images are generated.
import { generateText } from "../../ai/src/index";
import { generateScenarioBatch } from "../src/generator";

const count = Number(process.argv[2] ?? 6);
const seed = Number(process.argv[3] ?? Date.now() % 2 ** 32);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}
const batch = await generateScenarioBatch({ generate: generateText, count, seed });
console.log(JSON.stringify(batch, null, 2));
console.error(`seed ${seed}: ${batch.cases.length} accepted, ${batch.rejected.length} rejected`);
