/**
 * Approved English terms in Pack files (WP-620 Ф3).
 *
 * Pilot decision 2026-11-09: the approved English name of a term lives in the Pack, in a section
 * titled «Утверждённые английские термины» with a table whose «Утвердил» column carries
 * "пилот, YYYY-MM-DD". The concept graph and the translator glossary derive from it, so the
 * Pack indexer turns every table row into a concept node with that English name.
 *
 * Pure parsing only: no I/O, so it is unit-tested without a database.
 */

/** Bump when the table format or the row → concept mapping changes; part of the file content hash. */
export const APPROVED_TERMS_FORMAT_VERSION = "approved-terms/1";

const SECTION_HEADING = /^#{2,4}\s+(?:\d+(?:\.\d+)*\.?\s+)?Утвержд[её]нные английские термины\s*$/m;
const APPROVAL = /^пилот,\s*\d{4}-\d{2}-\d{2}$/;
/** Code infix of approved-term concepts; the loader prunes only codes carrying it. */
export const APPROVED_TERM_INFIX = ".TERM.";

const COLUMN_RU = "Термин (RU)";
const COLUMN_EN = "Term (EN)";
const COLUMN_ALTERNATIVES = "Не использовать / альтернативы";
const COLUMN_APPROVED = "Утвердил";

export interface ApprovedTerm {
  code: string;
  nameRu: string;
  nameEn: string;
  /** «Не использовать / альтернативы» cell, or null; the only note kept as the concept definition. */
  definition: string | null;
  /** true only when the «Утвердил» cell is "пилот, YYYY-MM-DD". */
  approved: boolean;
}

export interface ApprovedTermsParse {
  terms: ApprovedTerm[];
  /** Problems found (empty name, duplicate code, malformed approval, bad header); reported, never silently ignored. */
  rejected: string[];
  /**
   * false when the section exists but no readable table follows it. The caller must then keep
   * the terms already in the graph instead of treating the file as having an empty table.
   */
  tableReadable: boolean;
}

export function hasApprovedTermsSection(body: string): boolean {
  return SECTION_HEADING.test(body);
}

/** Stable, readable code derived from the Russian term itself, never from its position. */
export function approvedTermCode(domain: string, nameRu: string): string {
  const slug = nameRu
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${domain}${APPROVED_TERM_INFIX}${slug}`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function plain(cell: string | undefined): string {
  return (cell ?? "").replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function isDash(cell: string): boolean {
  return cell === "" || cell === "—" || cell === "-";
}

export function parseApprovedTerms(domain: string, body: string): ApprovedTermsParse {
  const result: ApprovedTermsParse = { terms: [], rejected: [], tableReadable: false };
  const heading = SECTION_HEADING.exec(body);
  if (!heading) return { ...result, tableReadable: true };

  const lines = body.slice(heading.index + heading[0].length).split(/\r?\n/);
  const tableStart = lines.findIndex((line) => line.trim().startsWith("|"));
  // A table must follow its heading before the next heading.
  if (tableStart < 0 || lines.slice(0, tableStart).some((line) => /^#{1,6}\s/.test(line))) {
    result.rejected.push("section has no table before the next heading");
    return result;
  }

  const header = splitRow(lines[tableStart]);
  const col = (name: string) => header.indexOf(name);
  const [iRu, iEn, iAlt, iApproved] = [COLUMN_RU, COLUMN_EN, COLUMN_ALTERNATIVES, COLUMN_APPROVED].map(col);
  if (iRu < 0 || iEn < 0 || iApproved < 0) {
    result.rejected.push(`table header lacks «${COLUMN_RU}», «${COLUMN_EN}» or «${COLUMN_APPROVED}»`);
    return result;
  }
  result.tableReadable = true;

  const seen = new Set<string>();
  // tableStart + 1 is the |---| separator row.
  for (const line of lines.slice(tableStart + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = splitRow(line);
    const nameRu = plain(cells[iRu]);
    const nameEn = plain(cells[iEn]);
    if (!nameRu || !nameEn) {
      result.rejected.push(`row without Russian or English name: ${line.trim()}`);
      continue;
    }
    const code = approvedTermCode(domain, nameRu);
    if (seen.has(code)) {
      result.rejected.push(`duplicate term «${nameRu}» (${code})`);
      continue;
    }
    seen.add(code);

    const approvedBy = plain(cells[iApproved]);
    const approved = APPROVAL.test(approvedBy);
    if (!approved && !isDash(approvedBy)) {
      result.rejected.push(`«${nameRu}»: approval «${approvedBy}» is not "пилот, YYYY-MM-DD", kept as not approved`);
    }
    const alternatives = iAlt >= 0 ? plain(cells[iAlt]) : "";

    result.terms.push({
      code,
      nameRu,
      nameEn,
      definition: isDash(alternatives) ? null : `Не использовать / альтернативы: ${alternatives}`,
      approved,
    });
  }
  return result;
}
