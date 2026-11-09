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

const SECTION_HEADING = /^#{2,4}\s+(?:\d+(?:\.\d+)*\.?\s+)?Утверждённые английские термины\s*$/m;
const APPROVAL = /^пилот,\s*\d{4}-\d{2}-\d{2}$/;

const COLUMN_RU = "Термин (RU)";
const COLUMN_EN = "Term (EN)";
const COLUMN_ALTERNATIVES = "Не использовать / альтернативы";
const COLUMN_WHERE = "Где употребляется";
const COLUMN_APPROVED = "Утвердил";

export interface ApprovedTerm {
  code: string;
  nameRu: string;
  nameEn: string;
  /** Human-readable note stored as the concept definition. */
  definition: string;
  /** true only when the «Утвердил» cell is "пилот, YYYY-MM-DD". */
  approved: boolean;
}

export interface ApprovedTermsParse {
  terms: ApprovedTerm[];
  /** Rows dropped with a reason (empty name, duplicate code); reported, never silently ignored. */
  rejected: string[];
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
  return `${domain}.TERM.${slug}`;
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
  const result: ApprovedTermsParse = { terms: [], rejected: [] };
  const heading = SECTION_HEADING.exec(body);
  if (!heading) return result;

  const lines = body.slice(heading.index + heading[0].length).split("\n");
  const tableStart = lines.findIndex((line) => line.trim().startsWith("|"));
  if (tableStart < 0) return result;
  // A table must follow its heading before the next heading.
  if (lines.slice(0, tableStart).some((line) => /^#{1,6}\s/.test(line))) return result;

  const header = splitRow(lines[tableStart]);
  const col = (name: string) => header.indexOf(name);
  const [iRu, iEn, iAlt, iWhere, iApproved] = [COLUMN_RU, COLUMN_EN, COLUMN_ALTERNATIVES, COLUMN_WHERE, COLUMN_APPROVED].map(col);
  if (iRu < 0 || iEn < 0 || iApproved < 0) {
    result.rejected.push(`table header lacks «${COLUMN_RU}», «${COLUMN_EN}» or «${COLUMN_APPROVED}»`);
    return result;
  }

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
    const alternatives = iAlt >= 0 ? plain(cells[iAlt]) : "";
    const where = iWhere >= 0 ? plain(cells[iWhere]) : "";
    const notes = [
      isDash(alternatives) ? null : `Не использовать / альтернативы: ${alternatives}`,
      isDash(where) ? null : `Где: ${where}`,
      `Утвердил: ${isDash(approvedBy) ? "не утверждено" : approvedBy}`,
    ].filter((note): note is string => note !== null);

    result.terms.push({
      code,
      nameRu,
      nameEn,
      definition: notes.join(". "),
      approved: APPROVAL.test(approvedBy),
    });
  }
  return result;
}
