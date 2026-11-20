import { describe, expect, it } from "vitest";
import { PRIVATE_READ_RESPONSE_BUDGET_BYTES } from "../personal-response-bounds.js";
import { cardPhase, normalizePhase, normalizeWpNumber, parseRegistry, selectRegistryRows, summarizeCard, wpCardPaths } from "./work-products.js";

const REGISTRY = `# WP-REGISTRY

| Статус | Расшифровка |
|--------|-------------|
| ✅ | done |
| 🔄 | in_progress |

| # | P | Название | Ст | Репо | Ставка | Бюджет | Прогресс |
|---|---|---------|-----|------|---|--------|----------|
| 622 | P2 | **Визионер** | 🔄 | DS-my-strategy | Увлечённость · H-353 | 14h | Ф1 ✅ · Ф2 в работе |
| 621 | P1 | **Инструменты MCP** | ⏳ | gateway-mcp | — | 34h | — |
| ~~620~~ | ~~P3~~ | ~~Переводчик~~ | ✅ | knowledge-mcp | — | 12h | done |
| 619 | P3, P1 | **Блокированный** | 🚧 | — | — | 6h | ждёт решения |
| 618 | P4 | **Слитый** | ↗️ | — | — | 1h | — |

## Сводка по проектам

| Проект | Название | Активных РП | Done РП |
|--------|----------|-------------|---------|
| **P1** | Проект | 7 | 5 |
`;

describe("parseRegistry", () => {
  it("reads only tables with the #/Название/Ст header and maps status emoji to words", () => {
    const rows = parseRegistry(REGISTRY);
    expect(rows.map(row => [row.wp, row.status])).toEqual([
      [622, "in_progress"], [621, "pending"], [620, "done"], [619, "blocked"], [618, "merged"],
    ]);
  });

  it("strips bold/strikethrough markup and treats a dash progress as empty", () => {
    const [visionary, tools, translator] = parseRegistry(REGISTRY);
    expect(visionary).toEqual({ wp: 622, status: "in_progress", priority: "P2", title: "Визионер", progress: "Ф1 ✅ · Ф2 в работе" });
    expect(tools.progress).toBeNull();
    expect(translator.title).toBe("Переводчик");
  });
});

describe("selectRegistryRows", () => {
  it("defaults to active rows (in_progress, pending, blocked) in registry order", () => {
    const result = selectRegistryRows(parseRegistry(REGISTRY));
    expect(result.rows.map(row => row.wp)).toEqual([622, 621, 619]);
    expect(result).toMatchObject({ status_filter: "active", total_matching: 3, returned: 3, truncated: false, progress_omitted: false });
  });

  it("drops the progress column before dropping any row", () => {
    const many = Array.from({ length: 130 }, (_, index) => ({
      wp: index + 1, status: "in_progress", priority: "P1", title: "Т".repeat(60), progress: "п".repeat(200),
    }));
    const result = selectRegistryRows(many);
    expect(result).toMatchObject({ returned: 130, truncated: false, progress_omitted: true });
    expect(result.rows[0]).not.toHaveProperty("progress");
  });

  it("filters by priority including multi-project cells, and by an exact status", () => {
    const rows = parseRegistry(REGISTRY);
    expect(selectRegistryRows(rows, { priority: "p1" }).rows.map(row => row.wp)).toEqual([621, 619]);
    expect(selectRegistryRows(rows, { status: "done" }).rows.map(row => row.wp)).toEqual([620]);
    expect(selectRegistryRows(rows, { status: "all", limit: 2 }).rows.map(row => row.wp)).toEqual([622, 621]);
  });

  it("stops before the private response budget and reports truncation", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      wp: index + 1, status: "in_progress", priority: "P1", title: "Т".repeat(150), progress: "п".repeat(200),
    }));
    const result = selectRegistryRows(many);
    expect(result.truncated).toBe(true);
    expect(result.progress_omitted).toBe(true);
    expect(result.returned).toBeLessThan(400);
    expect(result.total_matching).toBe(400);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });
});

describe("normalizeWpNumber / wpCardPaths", () => {
  it("accepts numbers and WP/РП prefixes, rejects garbage", () => {
    expect([560, "560", "WP-560", "РП-560", "рп560", " wp 560 "].map(normalizeWpNumber)).toEqual([560, 560, 560, 560, 560, 560]);
    expect([0, -3, 1.5, "abc", "WP-", "../560", null].map(normalizeWpNumber)).toEqual([null, null, null, null, null, null, null]);
  });

  it("tries the folder card first, then the legacy flat file", () => {
    expect(wpCardPaths(7)).toEqual(["inbox/WP-7/WP-7.md", "inbox/WP-7.md"]);
  });
});

const CARD = `---
wp: 560
title: "MCP с подпиской МИМ"
status: in_progress
priority: P1
last_session: "2026-11-16 — Ф20"
phases:
  Ф1: done
  Ф2: in_progress
  Ф3: pending
  Ф4: defer
related: [1, 2]
---

# WP-560

## Фазы реализации

### Ф1 — закрытая фаза
старое содержимое

### Ф2 (in_progress) — открытая фаза
- [ ] шаг
\`\`\`
### Ф9 внутри кода не считается
\`\`\`

#### Подраздел Ф2
детали

### Ф3 — ждёт
текст Ф3

### Ф4 — отложена
отложенное

## Осталось
- [ ] что-то
`;

describe("summarizeCard", () => {
  it("returns selected fields, the phase map and an overview of open phases only", () => {
    const card = summarizeCard(CARD);
    expect(card.fields).toEqual({ wp: 560, title: "MCP с подпиской МИМ", status: "in_progress", priority: "P1", last_session: "2026-11-16 — Ф20" });
    expect(card.open_phases).toEqual(["Ф2", "Ф3"]);
    expect(card.sections.map(section => [section.phase, section.status])).toEqual([["Ф2", "in_progress"], ["Ф3", "pending"]]);
    expect(card.excerpt_chars).toBe(800);
    expect(card.sections[1]).toMatchObject({ heading: "Ф3 — ждёт", excerpt: "### Ф3 — ждёт\nтекст Ф3", chars: 22 });
  });

  it("falls back to the «Осталось» section for a card without phase sections", () => {
    const card = summarizeCard("---\nwp: 7\nstatus: pending\n---\n# WP-7\n\n## Осталось\n- [ ] шаг\n\n## Журнал\nстарое\n");
    expect(card.phases).toBeNull();
    expect(card.sections).toEqual([{ phase: null, status: null, heading: "Осталось", excerpt: "## Осталось\n- [ ] шаг", chars: 21 }]);
  });

  it("shrinks excerpts, not the list of phases, when many open phases do not fit", () => {
    const count = 60;
    const phases = Array.from({ length: count }, (_, index) => `  Ф${index + 1}: in_progress`).join("\n");
    const sections = Array.from({ length: count }, (_, index) => `### Ф${index + 1} фаза\n${"ж".repeat(3_000)}`).join("\n");
    const card = summarizeCard(`---\nphases:\n${phases}\n---\n${sections}\n`);
    expect(card.sections).toHaveLength(count);
    expect(card.excerpt_chars).toBeLessThan(800);
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });

  it("tells a lettered sub-phase apart from its parent phase", () => {
    const card = summarizeCard("---\nphases:\n  Ф3: done\n  Ф3а: in_progress\n---\n### Ф3 — закрыта\nстарое\n### Ф3а — открыта\nновое\n");
    expect(card.sections.map(section => section.phase)).toEqual(["Ф3а"]);
  });

  it("survives a card with broken frontmatter", () => {
    const card = summarizeCard("---\nphases: [unclosed\n---\n### Ф1 фаза\nтекст\n");
    expect(card.fields).toEqual({});
    expect(card.frontmatter_warnings?.length).toBeGreaterThan(0);
    expect(card.sections.map(section => section.phase)).toEqual(["Ф1"]);
  });
});

describe("summarizeCard: real-world card shapes (review of knowledge-mcp#112)", () => {
  const LIST_CARD = `---
wp: 262
phases:
  - id: Ф1
    title: "Концепция"
    status: done
  - id: Ф2
    title: "Инструкции из одного источника"
    status: in_progress
    note: "блок Memory слит; дальше тег слоя"
  - id: Ф3а
    title: "Бот без доменной логики"
    status: in_progress
---
# WP-262

## Фазы
текст без заголовков фаз
`;

  it("reads a phase list of objects and takes the phase text from title and note", () => {
    const card = summarizeCard(LIST_CARD);
    expect(card.phases).toEqual({ Ф1: "done", Ф2: "in_progress", Ф3а: "in_progress" });
    expect(card.phases_unknown).toBe(false);
    expect(card.sections).toEqual([
      { phase: "Ф2", status: "in_progress", heading: "Ф2 — Инструкции из одного источника", excerpt: "блок Memory слит; дальше тег слоя", chars: 33 },
      { phase: "Ф3а", status: "in_progress", heading: "Ф3а — Бот без доменной логики", excerpt: "", chars: 0 },
    ]);
    expect(cardPhase(LIST_CARD, "Ф2")?.content).toBe("блок Memory слит; дальше тег слоя");
  });

  it("does not show closed phases as open when the map lists them, even if headings exist", () => {
    const card = summarizeCard("---\nphases:\n  Ф1: done\n  Ф2: pending\n---\n### Ф1 закрыта\nа\n### Ф2 ждёт\nб\n### Ф9 без записи в карте\nв\n");
    expect(card.sections.map(section => section.phase)).toEqual(["Ф2"]);
  });

  it("marks phases as unknown, not open, when the card has no phase map", () => {
    const card = summarizeCard("### Ф1 первая\nа\n### Ф2 вторая\nб\n");
    expect(card).toMatchObject({ phases: null, phases_unknown: true, open_phases: [] });
    expect(card.sections.map(section => [section.phase, section.status])).toEqual([["Ф1", null], ["Ф2", null]]);
  });

  it("keeps the header when a key is repeated (the last value wins)", () => {
    const card = summarizeCard("---\nwp: 406\nstatus: in_progress\nstatus: in_progress\nphases:\n  Ф1: done\n  Ф2: pending\n---\n### Ф2 ждёт\nб\n");
    expect(card.fields).toMatchObject({ wp: 406, status: "in_progress" });
    expect(card.open_phases).toEqual(["Ф2"]);
    expect(card.frontmatter_warnings).toBeUndefined();
  });

  it("treats completed, moved-to and annotated done statuses as closed", () => {
    const card = summarizeCard("---\nphases:\n  Ф1: completed\n  Ф2: moved-to-wp-498\n  Ф3: done (16.10)\n  Ф4: in_progress\n  Ф5: pending-review\n---\n");
    expect(card.open_phases).toEqual(["Ф4", "Ф5"]);
  });

  it("matches phase ids written in upper case", () => {
    const card = summarizeCard("---\nphases:\n  Ф3А: done\n  Ф4: pending\n---\n### Ф3а закрыта\nа\n### Ф4 ждёт\nб\n");
    expect(card.sections.map(section => section.phase)).toEqual(["Ф4"]);
  });
});

describe("response budget counts the double JSON encoding of the tool text", () => {
  const responseSize = (payload: unknown) =>
    new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })).length;

  it("a phase made of quotes and line breaks still fits", () => {
    const body = Array.from({ length: 4_000 }, () => '"x"').join("\n");
    const phase = cardPhase(`### Ф1 кавычки\n${body}\n`, "Ф1");
    expect(phase?.truncated).toBe(true);
    expect(responseSize(phase)).toBeLessThanOrEqual(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });

  it("an overview of many quoted phases still fits", () => {
    const phases = Array.from({ length: 60 }, (_, index) => `  Ф${index + 1}: in_progress`).join("\n");
    const sections = Array.from({ length: 60 }, (_, index) => `### Ф${index + 1} "фаза"\n${'"q"\n'.repeat(400)}`).join("\n");
    expect(responseSize(summarizeCard(`---\nphases:\n${phases}\n---\n${sections}\n`))).toBeLessThanOrEqual(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });

  it("a long registry with quoted titles still fits", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({ wp: index, status: "done", priority: "P1", title: '"т"'.repeat(50), progress: '"п"\n'.repeat(50) }));
    expect(responseSize(selectRegistryRows(rows, { status: "all", limit: 500 }))).toBeLessThanOrEqual(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });
});

describe("cardPhase", () => {
  it("returns the whole section with sub-headings, ignoring headings inside code fences", () => {
    const phase = cardPhase(CARD, "Ф2");
    expect(phase).toMatchObject({ phase: "Ф2", status: "in_progress", heading: "Ф2 (in_progress) — открытая фаза", truncated: false });
    expect(phase?.content).toContain("#### Подраздел Ф2");
    expect(phase?.content).toContain("### Ф9 внутри кода не считается");
    expect(phase?.content).not.toContain("текст Ф3");
  });

  it("returns a closed phase too when asked by name, and null for a missing one", () => {
    expect(cardPhase(CARD, "Ф1")?.content).toBe("### Ф1 — закрытая фаза\nстарое содержимое");
    expect(cardPhase(CARD, "Ф42")).toBeNull();
  });

  it("cuts an oversized section at the budget and says so", () => {
    const phase = cardPhase(`### Ф1 огромная\n${"щ".repeat(40_000)}\n`, "Ф1");
    expect(phase?.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(phase)).length).toBeLessThan(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
    expect(phase?.content.startsWith("### Ф1 огромная")).toBe(true);
  });
});

describe("normalizePhase", () => {
  it("accepts Ф/F prefixes and bare numbers, rejects garbage", () => {
    expect(["Ф22", "ф22", "22", 22, "F22", "Ф3А"].map(normalizePhase)).toEqual(["Ф22", "Ф22", "Ф22", "Ф22", "Ф22", "Ф3а"]);
    expect(["", "Ф", "фаза 2", null].map(normalizePhase)).toEqual([null, null, null, null]);
  });
});
