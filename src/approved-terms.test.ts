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
    expect(parsed.terms.map((t) => t.nameEn)).toEqual(["Dissatisfaction", "Practitioner State", "Worry"]);
  });

  it("marks a row approved only with a pilot date in «Утвердил»", () => {
    expect(parsed.terms.map((t) => t.approved)).toEqual([true, true, false]);
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

  it("keeps alternatives, place and approver in the definition, skipping dash cells", () => {
    expect(parsed.terms[0].definition).toBe(
      "Не использовать / альтернативы: не «unmet need». Где: DP.METHOD.053. Утвердил: пилот, 2026-11-09"
    );
    expect(parsed.terms[1].definition).toBe("Где: DP.METHOD.053. Утвердил: пилот, 2026-11-09");
    expect(parsed.terms[2].definition).toBe("Не использовать / альтернативы: Concern. Где: DP.METHOD.053. Утвердил: не утверждено");
  });
});

describe("section detection", () => {
  it("finds the heading with or without a section number", () => {
    expect(hasApprovedTermsSection("## 6. Утверждённые английские термины\n")).toBe(true);
    expect(hasApprovedTermsSection("### Утверждённые английские термины\n")).toBe(true);
    expect(hasApprovedTermsSection("Утверждённые английские термины в тексте\n")).toBe(false);
  });

  it("returns nothing when the heading has no table before the next heading", () => {
    const body = "## Утверждённые английские термины\n\nскоро\n\n## Другое\n| Термин (RU) | Term (EN) | Утвердил |\n|---|---|---|\n| А | B | пилот, 2026-11-09 |\n";
    expect(parseApprovedTerms("DP", body)).toEqual({ terms: [], rejected: [] });
  });

  it("reports a table whose header lacks a required column", () => {
    const body = "## Утверждённые английские термины\n| Термин (RU) | Term (EN) |\n|---|---|\n| А | B |\n";
    const parsed = parseApprovedTerms("DP", body);
    expect(parsed.terms).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
  });
});

describe("term code", () => {
  it("is stable for the same term and independent of punctuation", () => {
    expect(approvedTermCode("MIM", "Необходимость (B, C)")).toBe("MIM.TERM.необходимость-b-c");
    expect(approvedTermCode("DP", "Хаос / Потолок / Поворот / Развитие")).toBe("DP.TERM.хаос-потолок-поворот-развитие");
  });
});
