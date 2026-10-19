import { readFile } from "node:fs/promises";
import { annotationKey, annotationTasks, evaluate, parseEvaluation } from "../src/retrieval-evaluation.js";

const [command, filename, ...extra] = process.argv.slice(2);
if (!["compare", "annotate", "annotation-key"].includes(command) || !filename || extra.length) {
  console.error("Usage: npm run eval:retrieval -- <compare|annotate|annotation-key> <input.json>");
  process.exitCode = 2;
} else {
  try {
    const input = parseEvaluation(JSON.parse(await readFile(filename, "utf8")));
    if (command === "compare") {
      const report = evaluate(input);
      console.log(JSON.stringify(report, null, 2));
      // A green exit means evidence is ready for review, never deployment approval.
      process.exitCode = report.status === "candidate_for_review" ? 0 : 1;
    } else {
      console.log(JSON.stringify(command === "annotate" ? annotationTasks(input) : annotationKey(input), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
