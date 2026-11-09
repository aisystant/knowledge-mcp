import { describe, expect, it } from "vitest";
import { approvedTermCode, hasApprovedTermsSection, parseApprovedTerms } from "./approved-terms.js";

const TABLE = `
## 2. Глоссарий домена

| Термин (RU) | Term (EN) | Определение |
|---|---|---|
| **Неудовлетворённость** | Dissatisfaction | не эта таблица |

### 2.1. Утверждённые английские термины

> Source-of-truth английского имени.

| Термин (RU) | Term (EN) | Не использовать / альтернативы | Где употребляется | Утвердил |
|-------------|-----------|-------------------------------|-------------------|----------|
| Неудовлетворённость | Dissatisfaction | не «unmet need» | DP.METHOD.053 | пилот, 2026-11-09 |
| **Состояние пилота** | Practitioner State | — | DP.METHOD.053 | пилот, 2026-11-09 |
| Беспокойство | Worry | Concern | DP.METHOD.053 | — |
| Чувство | Feeling | — | DP.METHOD.053 | Пилот, 09.11.2026 |
| Неудовлетворенность | Discontent | — | — | пилот, 2026-11-09 |
| Пустое имя |  | — | — | пилот, 2026-11-09 |

## 3. Отношения
| Термин (RU) | Term (EN) | Утвердил |
|---|---|---|
| Чужая | Foreign | пилот, 2026-11-09 |
`;

describe("approved English terms table", () => {
  const parsed = parseApprovedTerms("DP", TABLE);

  it("reads only the rows of the approved-terms table, not the glossary or later tables", () => {
    expect(parsed.tableReadable).toBe(true);
    expect(parsed.terms.map((t) => t.nameEn)).toEqual(["Dissatisfaction", "Practitioner State", "Worry", "Feeling"]);
  });

  it("marks a row approved only with a pilot date in «Утвердил»", () => {
    expect(parsed.terms.map((t) => t.approved)).toEqual([true, true, false, false]);
  });

  it("reports a malformed approval loudly instead of silently treating it as not approved", () => {
    expect(parsed.rejected).toContain(
      '«Чувство»: approval «Пилот, 09.11.2026» is not "пилот, YYYY-MM-DD", kept as not approved'
    );
    expect(parsed.rejected.some((r) => r.startsWith("«Беспокойство»"))).toBe(false);
  });

  it("strips markdown emphasis from the Russian term", () => {
    expect(parsed.terms[1].nameRu).toBe("Состояние пилота");
  });

  it("builds the code from the term (ё = е), so a ё/е spelling twin is a duplicate", () => {
    expect(parsed.terms[0].code).toBe("DP.TERM.неудовлетворенность");
    expect(parsed.rejected).toContain("duplicate term «Неудовлетворенность» (DP.TERM.неудовлетворенность)");
  });

  it("rejects a row without an English name and says which row", () => {
    expect(parsed.rejected.some((r) => r.startsWith("row without Russian or English name: | Пустое имя"))).toBe(true);
  });

  it("keeps only the alternatives note as the definition (no bookkeeping in the search text)", () => {
    expect(parsed.terms.map((t) => t.definition)).toEqual([
      "Не использовать / альтернативы: не «unmet need»",
      null,
      "Не использовать / альтернативы: Concern",
      null,
    ]);
  });
});

describe("table shape", () => {
  it("finds columns by name, in any order and without optional columns, with CRLF line ends", () => {
    const body = "## Утверждённые английские термины\r\n| Утвердил | Term (EN) | Термин (RU) |\r\n|---|---|---|\r\n| пилот, 2026-11-09 | Problem | Проблема |\r\n";
    const parsed = parseApprovedTerms("DP", body);
    expect(parsed.terms).toEqual([
      { code: "DP.TERM.проблема", nameRu: "Проблема", nameEn: "Problem", definition: null, approved: true },
    ]);
  });

  it("marks the table unreadable when the heading has no table before the next heading", () => {
    const body = "## Утверждённые английские термины\n\nскоро\n\n## Другое\n| Термин (RU) | Term (EN) | Утвердил |\n|---|---|---|\n| А | B | пилот, 2026-11-09 |\n";
    expect(parseApprovedTerms("DP", body)).toEqual({
      terms: [],
      rejected: ["section has no table before the next heading"],
      tableReadable: false,
    });
  });

  it("marks the table unreadable when the header lacks a required column", () => {
    const body = "## Утверждённые английские термины\n| Термин (RU) | Термин (EN) | Утвердил |\n|---|---|---|\n| А | B | пилот, 2026-11-09 |\n";
    const parsed = parseApprovedTerms("DP", body);
    expect(parsed.tableReadable).toBe(false);
    expect(parsed.terms).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
  });

  it("treats a file without the section as readable and empty, so its old terms are pruned", () => {
    expect(parseApprovedTerms("DP", "# Карточка\n\nтекст\n")).toEqual({ terms: [], rejected: [], tableReadable: true });
  });
});

describe("section detection", () => {
  it("finds the heading with or without a number, spelled with ё or е", () => {
    expect(hasApprovedTermsSection("## 6. Утверждённые английские термины\n")).toBe(true);
    expect(hasApprovedTermsSection("### Утвержденные английские термины\n")).toBe(true);
    expect(hasApprovedTermsSection("Утверждённые английские термины в тексте\n")).toBe(false);
  });
});

describe("term code", () => {
  it("is stable for the same term and independent of punctuation", () => {
    expect(approvedTermCode("MIM", "Необходимость (B, C)")).toBe("MIM.TERM.необходимость-b-c");
    expect(approvedTermCode("DP", "Хаос / Потолок / Поворот / Развитие")).toBe("DP.TERM.хаос-потолок-поворот-развитие");
  });
});
