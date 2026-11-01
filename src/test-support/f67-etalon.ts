/**
 * Reader of the 19-code acceptance table (WP-5 F67 -> WP-596).
 *
 * f67-etalon.md is a copy of inbox/WP-5/f67-nabor-priemki-shluza.md (DS-my-strategy).
 * It lives here so the acceptance check runs on every `npm test`; if the owner changes
 * the table, replace the copy.
 */

import { readFileSync } from "node:fs";

export type EtalonRow = {
  code: string;
  /** The row as the database returns it; null when the table says the concept is not in the graph. */
  dbRow: { name_en: string | null; name_en_status: string } | null;
  publishable: boolean;
  rulesVersion: string;
};

const NOT_IN_GRAPH = "строки в графе нет";

export function readEtalon(): EtalonRow[] {
  const markdown = readFileSync(new URL("./f67-etalon.md", import.meta.url), "utf8");
  const rows: EtalonRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[0] ?? "")) continue;
    const [, code, nameEn, statusRaw, publishable, rulesVersion] = cells as [string, string, string, string, string, string];
    if ([nameEn, statusRaw, publishable, rulesVersion].every((cell) => cell === NOT_IN_GRAPH)) {
      rows.push({ code, dbRow: null, publishable: false, rulesVersion: "" });
      continue;
    }
    rows.push({
      code,
      dbRow: { name_en: nameEn === "null" ? null : nameEn, name_en_status: statusRaw },
      publishable: publishable === "true",
      rulesVersion,
    });
  }
  return rows;
}
