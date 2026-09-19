import { writeFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import { verifyJwtLocally } from "../src/auth.js";
import { exportOwnObservations, OBSERVATION_RETENTION_DAYS } from "../src/retrieval-observations.js";

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
  console.error("Usage: npm run export:retrieval -- <private-output.json> (Node >=22)");
  process.exitCode = 2;
} else {
  try {
    const { ORY_URL, RETRIEVAL_EXPORT_JWT, RETRIEVAL_OBSERVATION_DATABASE_URL } = process.env;
    if (!ORY_URL || !RETRIEVAL_EXPORT_JWT || !RETRIEVAL_OBSERVATION_DATABASE_URL) throw new Error("missing_environment");
    const accountId = await verifyJwtLocally(ORY_URL, RETRIEVAL_EXPORT_JWT);
    if (!accountId) throw new Error("unverified_account");
    neonConfig.webSocketConstructor = WebSocket;
    const candidates = await exportOwnObservations({ RETRIEVAL_OBSERVATION_DATABASE_URL }, accountId);
    await writeFile(output, JSON.stringify({ version: 1, kind: "unlabelled-platform-query-candidates",
      exportedAt: new Date().toISOString(), rawRecordRetentionDays: OBSERVATION_RETENTION_DAYS,
      expiryBasis: "each candidate expires_at; export does not reset the clock", candidates }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Exported ${candidates.length} candidates. Not an evaluation dataset; keep the file private.`);
  } catch {
    // Driver errors and failed filesystem writes can include sensitive details.
    console.error("Export failed. Check verified JWT, least-privilege database access and a new private output path.");
    process.exitCode = 2;
  }
}
