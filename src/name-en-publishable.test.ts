/**
 * Приёмка 19 кодов из inbox/WP-5/f67-nabor-priemki-shluza.md.
 * Боевая база не читается: на вход идут уже снятые name_en и name_en_status.
 * F67_ETALON — путь к этому файлу; тогда тест сверяет таблицу с функцией.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONCEPT_NOT_FOUND,
  NAME_EN_PUBLISHABLE_RULES_VERSION,
  type NameEnDbRow,
  type NameEnFields,
  attachNameEnFields,
  nameEnAsOf,
  nameEnFields,
  nameEnPublishableShare,
  projectNameEn,
} from "./name-en-publishable.js";

type AcceptanceRow = {
  code: string;
  row: NameEnDbRow | null;
  name_en: string | null;
  name_en_status_raw: string | null;
  name_en_publishable: boolean;
};

const ACCEPTANCE: AcceptanceRow[] = [
  { code: "DP.SC.045", row: { name_en: "Constraint Analysis (TOC)", name_en_status: "ok" }, name_en: "Constraint Analysis (TOC)", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "ECO.PRIN.001", row: null, name_en: null, name_en_status_raw: null, name_en_publishable: false },
  { code: "MIM.M.030", row: { name_en: "System Type Classifier", name_en_status: "ok" }, name_en: "System Type Classifier", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "LS.FORM.007", row: { name_en: "Pull request register", name_en_status: "ok" }, name_en: "Pull request register", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "PD.METHOD.008", row: { name_en: "Strategizing", name_en_status: "ok" }, name_en: "Strategizing", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "DP.SC.108", row: { name_en: "Team Formation", name_en_status: "ok" }, name_en: "Team Formation", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "ECO.FM.001", row: { name_en: "ECO.FM.001", name_en_status: "ok" }, name_en: "ECO.FM.001", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "MIM.M.024", row: { name_en: null, name_en_status: "ok" }, name_en: null, name_en_status_raw: "ok", name_en_publishable: false },
  { code: "LS.BC.001", row: { name_en: "LS.BC.001", name_en_status: "ok" }, name_en: "LS.BC.001", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "PD.SOTA.008", row: { name_en: null, name_en_status: "ok" }, name_en: null, name_en_status_raw: "ok", name_en_publishable: false },
  { code: "ZP.1", row: { name_en: "Axiomaticity", name_en_status: "ok" }, name_en: "Axiomaticity", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "ZP.2", row: { name_en: "Structurality and Symmetries", name_en_status: "ok" }, name_en: "Structurality and Symmetries", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "U.Entity", row: { name_en: "Entity", name_en_status: "ok" }, name_en: "Entity", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "U.Method", row: { name_en: "Method", name_en_status: "ok" }, name_en: "Method", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "U.Role", row: { name_en: "Role", name_en_status: "ok" }, name_en: "Role", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "AR.D.005", row: null, name_en: null, name_en_status_raw: null, name_en_publishable: false },
  { code: "AR.008", row: { name_en: null, name_en_status: "ok" }, name_en: null, name_en_status_raw: "ok", name_en_publishable: false },
  { code: "VR.FM.002", row: { name_en: "False Confidence", name_en_status: "ok" }, name_en: "False Confidence", name_en_status_raw: "ok", name_en_publishable: true },
  { code: "VR.BC.001", row: { name_en: "Bounded Context — Verification and Acceptance", name_en_status: "ok" }, name_en: "Bounded Context — Verification and Acceptance", name_en_status_raw: "ok", name_en_publishable: true },
];

function expectedFields(item: AcceptanceRow): NameEnFields {
  return {
    name_en: item.name_en,
    name_en_status_raw: item.name_en_status_raw,
    name_en_publishable: item.name_en_publishable,
    name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
  };
}

describe("name-en publishable, 19 codes", () => {
  it("names one non-empty rules version", () => {
    expect(NAME_EN_PUBLISHABLE_RULES_VERSION).toBe("name-en-publishable/1");
    expect(NAME_EN_PUBLISHABLE_RULES_VERSION.trim()).not.toBe("");
  });

  it("matches the acceptance set with zero discrepancies", () => {
    expect(ACCEPTANCE).toHaveLength(19);
    const versions = new Set<string>();
    for (const item of ACCEPTANCE) {
      const got = projectNameEn(item.row);
      if (item.row === null) {
        expect(got, item.code).toEqual(CONCEPT_NOT_FOUND);
        expect(got, item.code).not.toHaveProperty("name_en");
        expect(got, item.code).not.toHaveProperty("name_en_status_raw");
        expect(got, item.code).not.toHaveProperty("name_en_publishable");
        continue;
      }
      expect(got, item.code).toEqual(expectedFields(item));
      versions.add((got as NameEnFields).name_en_publishable_rules_version);
    }
    expect(versions.size).toBe(1);
  });

  it("keeps an empty name with status ok as null, ok, false", () => {
    expect(nameEnFields(null, "ok")).toEqual({
      name_en: null,
      name_en_status_raw: "ok",
      name_en_publishable: false,
      name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
    });
    expect(nameEnFields("", "ok").name_en).toBeNull();
    expect(nameEnFields("   ", "ok").name_en).toBeNull();
    expect(nameEnFields(" \t", "ok").name_en_publishable).toBe(false);
  });

  it("returns a code stored as the name and marks it publishable", () => {
    const got = nameEnFields("ECO.FM.001", "ok");
    expect(got.name_en).toBe("ECO.FM.001");
    expect(got.name_en_publishable).toBe(true);
  });

  it("passes a non-ok status through and does not publish it", () => {
    expect(nameEnFields("Hidden", "flagged")).toMatchObject({
      name_en: "Hidden",
      name_en_status_raw: "flagged",
      name_en_publishable: false,
    });
    expect(nameEnFields("Hidden", "pending").name_en_status_raw).toBe("pending");
    expect(nameEnFields("Hidden", "FLAGGED").name_en_status_raw).toBe("FLAGGED");
    expect(nameEnFields("Hidden", "FLAGGED").name_en_publishable).toBe(false);
  });

  it("leaves the russian name, level, domain and concept status in place", () => {
    const got = attachNameEnFields({
      id: 1,
      code: "ZP.1",
      name: "Аксиоматичность",
      level: "zp",
      domain: null,
      status: "active",
      name_en: "Axiomaticity",
      name_en_status: "ok",
    });
    expect(got.name).toBe("Аксиоматичность");
    expect(got.level).toBe("zp");
    expect(got.domain).toBeNull();
    expect(got.status).toBe("active");
    expect(got).not.toHaveProperty("name_en_status");
    expect(got.name_en).toBe("Axiomaticity");
    expect(got.name_en_publishable).toBe(true);
  });

  it("counts publishable share over active concepts", () => {
    const present = ACCEPTANCE.filter((item) => item.row !== null);
    const count = present.filter((item) => item.name_en_publishable).length;
    expect(count).toBe(14);
    expect(nameEnPublishableShare(count, present.length)).toBe(0.823529);
    expect(nameEnPublishableShare(0, 0)).toBe(0);
    expect(nameEnPublishableShare(3, 5788)).toBe(0.000518);
  });

  it("formats the snapshot mark from the database clock", () => {
    expect(nameEnAsOf(new Date("2026-11-01T12:00:00.000Z"))).toBe("2026-11-01T12:00:00.000Z");
    expect(nameEnAsOf("2026-11-01 12:00:00+00")).toBe("2026-11-01T12:00:00.000Z");
    expect(() => nameEnAsOf(null)).toThrow(/as_of/);
  });
});

function parseEtalon(markdown: string): Array<{ code: string; cells: string[] }> {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[0] ?? "")) continue;
    rows.push({ code: cells[1] ?? "", cells });
  }
  return rows;
}

describe("etalon file", () => {
  const path = process.env.F67_ETALON;
  it.skipIf(!path)("matches inbox/WP-5/f67-nabor-priemki-shluza.md with zero discrepancies", () => {
    const parsed = parseEtalon(readFileSync(path!, "utf8"));
    expect(parsed).toHaveLength(19);
    expect(parsed.map((row) => row.code)).toEqual(ACCEPTANCE.map((row) => row.code));
    for (let i = 0; i < parsed.length; i++) {
      const file = parsed[i]!;
      const item = ACCEPTANCE[i]!;
      const got = projectNameEn(item.row);
      if (item.row === null) {
        expect(file.cells.slice(2), file.code).toEqual([
          "строки в графе нет",
          "строки в графе нет",
          "строки в графе нет",
          "строки в графе нет",
        ]);
        expect(got, file.code).toEqual(CONCEPT_NOT_FOUND);
        continue;
      }
      const fields = got as NameEnFields;
      expect(file.cells[2], file.code).toBe(fields.name_en === null ? "null" : fields.name_en);
      expect(file.cells[3], file.code).toBe(fields.name_en_status_raw);
      expect(file.cells[4], file.code).toBe(String(fields.name_en_publishable));
      expect(file.cells[5], file.code).toBe(fields.name_en_publishable_rules_version);
    }
  });
});
