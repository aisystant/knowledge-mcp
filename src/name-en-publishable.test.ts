/**
 * Pure rules of the English-name fields (WP-596 F67), checked against the 19-code acceptance table
 * (copy of the owner table, see test-support/f67-etalon.ts).
 */

import { describe, expect, it } from "vitest";
import {
  NAME_EN_BLANK_CHARS,
  NAME_EN_PUBLISHABLE_RULES_VERSION,
  attachNameEnFields,
  nameEnAsOf,
  nameEnFields,
  nameEnPublishableShare,
} from "./name-en-publishable.js";
import { readEtalon } from "./test-support/f67-etalon.js";

describe("acceptance table of 19 codes", () => {
  const etalon = readEtalon();

  it("has the 19 codes of the owner table", () => {
    expect(etalon).toHaveLength(19);
    expect(etalon.filter((row) => row.dbRow === null).map((row) => row.code)).toEqual(["ECO.PRIN.001", "AR.D.005"]);
  });

  it("gives every code present in the graph the flag and version of the table", () => {
    for (const row of etalon) {
      if (row.dbRow === null) continue;
      const got = nameEnFields(row.dbRow.name_en, row.dbRow.name_en_status);
      expect(got.name_en, row.code).toBe(row.dbRow.name_en);
      expect(got.name_en_status_raw, row.code).toBe(row.dbRow.name_en_status);
      expect(got.name_en_publishable, row.code).toBe(row.publishable);
      expect(got.name_en_publishable_rules_version, row.code).toBe(row.rulesVersion);
    }
  });

  it("publishes 14 of the 17 codes present in the graph, a share of 0.823529", () => {
    const present = etalon.filter((row) => row.dbRow !== null);
    const publishable = present.filter((row) => row.publishable).length;
    expect(present).toHaveLength(17);
    expect(publishable).toBe(14);
    expect(nameEnPublishableShare(publishable, present.length)).toBe(0.823529);
  });
});

describe("rules of name-en-publishable/1", () => {
  it("names the rules version", () => {
    expect(NAME_EN_PUBLISHABLE_RULES_VERSION).toBe("name-en-publishable/1");
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
  });

  it("answers null, null, false when the database columns are missing from the row", () => {
    expect(nameEnFields(undefined, undefined)).toEqual({
      name_en: null,
      name_en_status_raw: null,
      name_en_publishable: false,
      name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
    });
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
    expect(got).toMatchObject({ name: "Аксиоматичность", level: "zp", domain: null, status: "active", name_en: "Axiomaticity", name_en_publishable: true });
    expect(got).not.toHaveProperty("name_en_status");
  });
});

describe("blank names", () => {
  it("treats a name made of any whitespace character as empty", () => {
    for (const ch of NAME_EN_BLANK_CHARS) {
      const got = nameEnFields(`${ch}${ch}`, "ok");
      expect(got.name_en, `U+${ch.codePointAt(0)!.toString(16)}`).toBeNull();
      expect(got.name_en_publishable).toBe(false);
    }
  });

  it("matches exactly the characters String.trim removes, so SQL btrim and TypeScript agree", () => {
    const trimmed = new Set<string>();
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      if (ch.trim() === "") trimmed.add(ch);
    }
    expect(new Set(NAME_EN_BLANK_CHARS)).toEqual(trimmed);
  });

  it("keeps a name with a letter among whitespace", () => {
    expect(nameEnFields(" Entity\t", "ok").name_en).toBe(" Entity\t");
  });
});

describe("share and snapshot mark", () => {
  it("counts the share with six decimals and tolerates zero concepts", () => {
    expect(nameEnPublishableShare(0, 0)).toBe(0);
    expect(nameEnPublishableShare(3, 5788)).toBe(0.000518);
    expect(nameEnPublishableShare(3308, 5788)).toBe(0.571527);
  });

  it("formats the mark from the database clock", () => {
    expect(nameEnAsOf(new Date("2026-11-01T12:00:00.000Z"))).toBe("2026-11-01T12:00:00.000Z");
    expect(nameEnAsOf("2026-11-01 12:00:00+00")).toBe("2026-11-01T12:00:00.000Z");
  });

  it("falls back to the worker clock instead of failing when the value does not parse", () => {
    const now = () => new Date("2026-11-01T15:00:00.000Z");
    expect(nameEnAsOf(null, now)).toBe("2026-11-01T15:00:00.000Z");
    expect(nameEnAsOf("not a date", now)).toBe("2026-11-01T15:00:00.000Z");
    expect(nameEnAsOf(new Date("x"), now)).toBe("2026-11-01T15:00:00.000Z");
  });
});
