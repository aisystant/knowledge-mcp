/**
 * Английское имя понятия в ответе шлюза (РП-596, запрос РП-5 Ф67).
 *
 * Версия списка name-en-publishable/1. Список этой версии — один статус `ok`.
 * Публиковать можно только при непустом name_en и этом статусе.
 * Шлюз не переименовывает статус и не подменяет имя, даже если оно равно коду.
 * Пустая версия запрещена: выгрузчик снимка с пустой версией файл не пишет.
 */

export const NAME_EN_PUBLISHABLE_RULES_VERSION = "name-en-publishable/1";
export const NAME_EN_PUBLISHABLE_STATUS = "ok";

export const CONCEPT_NOT_FOUND = { not_found: true } as const;

export type NameEnFields = {
  name_en: string | null;
  name_en_status_raw: string | null;
  name_en_publishable: boolean;
  name_en_publishable_rules_version: string;
};

export type NameEnDbRow = {
  name_en: string | null;
  name_en_status: string | null;
};

/** Непустое имя — строка, в которой после обрезки пробелов по краям что-то остаётся. */
export function nameEnFields(nameEn: unknown, statusRaw: unknown): NameEnFields {
  const name_en = typeof nameEn === "string" && nameEn.trim() !== "" ? nameEn : null;
  const name_en_status_raw = typeof statusRaw === "string" ? statusRaw : null;
  return {
    name_en,
    name_en_status_raw,
    name_en_publishable: name_en !== null && name_en_status_raw === NAME_EN_PUBLISHABLE_STATUS,
    name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
  };
}

/** Строки в графе нет: ответ «не найдено», без выдуманных полей имени. */
export function projectNameEn(row: NameEnDbRow | null): NameEnFields | typeof CONCEPT_NOT_FOUND {
  if (row === null) return CONCEPT_NOT_FOUND;
  return nameEnFields(row.name_en, row.name_en_status);
}

/** Снимает колонки базы и ставит четыре поля контракта. Остальные поля строки не трогает. */
export function attachNameEnFields<T extends { name_en?: unknown; name_en_status?: unknown }>(
  row: T,
): Omit<T, "name_en" | "name_en_status"> & NameEnFields {
  const { name_en, name_en_status, ...rest } = row;
  return {
    ...rest,
    ...nameEnFields(name_en, name_en_status),
  };
}

/**
 * Доля публикуемых английских имён. Знаменатель — число активных понятий,
 * то же, что поле concepts в graph_stats. Ноль активных понятий даёт 0.
 * Шесть знаков после запятой, чтобы ответ не плавал на границе двоичной дроби.
 */
export function nameEnPublishableShare(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count < 0) return 0;
  return Math.round((count / total) * 1_000_000) / 1_000_000;
}

/** Отметка снимка graph_stats: часы базы, UTC, ISO-8601. */
export function nameEnAsOf(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error("graph_stats as_of is missing");
}
