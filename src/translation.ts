/**
 * Concept name translation helpers — WP-439 Ф5
 *
 * Two-tier lookup:
 * 1. GLOSSARY exact match (synchronous) → source=glossary, status=ok
 * 2. LLM call via OpenRouter (async, 3s timeout) → source=llm, status=pending
 *
 * WHY embedded constant: concept-indexer.ts runs inside a Cloudflare Worker
 * where the fs module is unavailable. The glossary is embedded at build time.
 * Source of truth: data/glossary-v0.1.csv — edit that file and regenerate.
 * Regenerate: npx tsx scripts/build-glossary-anchor.ts
 */

// Embedded from data/glossary-v0.1.csv — DO NOT EDIT MANUALLY
const GLOSSARY_MAP: ReadonlyMap<string, string> = new Map([
  ["созидатель", "Creator"],
  ["ступень мастерства", "Mastery stage"],
  ["рабочий продукт", "Work Product"],
  ["скилл", "Skill"],
  ["среда", "Environment"],
  ["пак", "Pack"],
  ["конвейер", "Pipeline"],
  ["рубеж работы", "Work milestone"],
  ["напарник", "Peer partner"],
  ["открытие", "Opening"],
  ["закрытие", "Closing"],
  ["рабочий ход", "Work turn"],
  ["аудит", "Audit"],
  ["различение", "Distinction"],
  ["поток", "Flow/Stream"],
  ["форматирование", "Formatting"],
  ["ролевой префикс", "Role prefix"],
  ["блокирующее правило", "Blocking rule"],
  ["предметная область", "Domain"],
  ["ограниченный контекст", "Bounded Context"],
  ["агрегат", "Aggregate"],
  ["репозиторий", "Repository"],
  ["фабрика", "Factory"],
  ["сервис предметной области", "Domain Service"],
  ["событие предметной области", "Domain Event"],
  ["общий язык", "Ubiquitous Language"],
  ["антикоррупционный слой", "Anti-Corruption Layer"],
  ["карта контекстов", "Context Map"],
  ["системное мышление", "Systems Thinking"],
  ["целевая система", "System of Interest"],
  ["надсистема", "Supersystem"],
  ["подсистема", "Subsystem"],
  ["роль", "Role"],
  ["исполнитель роли", "Role Performer"],
  ["функциональное место", "Functional Position"],
  ["метод", "Method"],
  ["практика", "Practice"],
  ["дисциплина", "Discipline"],
  ["область знаний", "Knowledge Domain"],
  ["онтология", "Ontology"],
  ["концепция", "Concept"],
  ["артефакт", "Artifact"],
  ["заинтересованная сторона", "Stakeholder"],
  ["потребность", "Need"],
  ["требование", "Requirement"],
  ["ограничение", "Constraint"],
  ["интерфейс", "Interface"],
  ["архитектура", "Architecture"],
  ["компонент", "Component"],
  ["модуль", "Module"],
  ["платформа", "Platform"],
  ["сервис", "Service"],
  ["инфраструктура", "Infrastructure"],
  ["реестр", "Registry"],
  ["протокол", "Protocol"],
  ["сессия", "Session"],
  ["шаг", "Step"],
  ["фаза", "Phase"],
  ["приоритет", "Priority"],
  ["бэклог", "Backlog"],
  ["верификация", "Verification"],
  ["ревью", "Review"],
  ["хук", "Hook"],
  ["скрипт", "Script"],
  ["шаблон", "Template"],
  ["манифест", "Manifest"],
  ["конфигурация", "Configuration"],
  ["развёртывание", "Deployment"],
  ["интеграция", "Integration"],
  ["миграция", "Migration"],
  ["рефакторинг", "Refactoring"],
  ["мастерство", "Mastery"],
  ["компетенция", "Competency"],
  ["навык", "Skill"],
  ["знание", "Knowledge"],
  ["понимание", "Understanding"],
  ["опыт", "Experience"],
  ["практикующий", "Practitioner"],
  ["систематический", "Systematic"],
  ["дисциплинированный", "Disciplined"],
  ["проактивный", "Proactive"],
  ["траектория", "Trajectory"],
  ["прогресс", "Progress"],
  ["оценка", "Assessment"],
  ["профиль", "Profile"],
  ["траектория развития", "Development Trajectory"],
  ["итерация", "Iteration"],
  ["спринт", "Sprint"],
  ["ретроспектива", "Retrospective"],
  ["дорожная карта", "Roadmap"],
  ["веха", "Milestone"],
  ["инцидент", "Incident"],
  ["постмортем", "Postmortem"],
  ["операция", "Operation"],
  ["мониторинг", "Monitoring"],
  ["наблюдаемость", "Observability"],
  ["персона", "Persona"],
  ["память", "Memory"],
  ["проекция", "Projection"],
  ["резервная копия", "Backup"],
  ["шифрование", "Encryption"],
  ["онбординг", "Onboarding"],
  ["карточки практик саморазвития", "Self-Development Practice Cards"],
  ["матрица нормативных состояний по ступеням", "Normative State Matrix By Level"],
  ["ролевая траектория созидателя", "Creator Role Trajectory Model"],
  ["карта роста созидателя", "Creator Growth Map"],
]);

export interface TranslationResult {
  nameEn: string;
  source: "glossary" | "llm";
  status: "ok" | "pending";
}

/** Glossary exact match (case-insensitive). Returns null on miss. */
export function glossaryLookup(nameRu: string): TranslationResult | null {
  const key = nameRu.trim().toLowerCase();
  const found = GLOSSARY_MAP.get(key);
  if (!found) return null;
  return { nameEn: found, source: "glossary", status: "ok" };
}

/**
 * LLM translation via OpenRouter with a hard timeout.
 *
 * Returns null on timeout, network error, or empty response so callers
 * can fall through to the pending-queue path without crashing.
 */
export async function translateWithLlm(
  nameRu: string,
  kindHint: string | null,
  openrouterKey: string,
  timeoutMs = 3000,
): Promise<TranslationResult | null> {
  const prompt = buildPrompt(nameRu, kindHint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 30,
        temperature: 0.1,
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? null;

    if (!text || text.length === 0 || text.length > 120) return null;
    return { nameEn: text, source: "llm", status: "pending" };
  } catch (err: unknown) {
    const tag = err instanceof Error ? err.name : "unknown";
    console.warn(`[translateWithLlm] skipping "${nameRu}": ${tag}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(nameRu: string, kindHint: string | null): string {
  const context = kindHint ? ` This term is a kind of "${kindHint}".` : "";
  return `Translate this Russian domain concept term to English.${context} Reply with ONLY the English term, no explanation, no punctuation at end.\n\nTerm: ${nameRu}`;
}
