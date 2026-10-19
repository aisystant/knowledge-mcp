import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { buildPostScaffold, parsePostConvention, parsePostScaffold } from "./post-scaffold.js";
import { POST_CONVENTION_FIXTURE } from "./post-scaffold.test-fixture.js";

const convention = parsePostConvention(JSON.stringify(POST_CONVENTION_FIXTURE));
const DRAFT_ID = "00000000-0000-4000-8000-000000000001";

describe("publication convention shared with the Python renderer", () => {
  it.each([
    {
      date: "2026-01-01", channels: ["telegram", "club", "telegram"], previous: [],
      folder: "docs/2026/12-январь/01-01-2026-01-01-shared-check",
      names: ["01-01-1-club-2026-01-01.md", "01-01-4-telegram-2026-01-01.md"],
    },
    {
      date: "2026-12-31", channels: ["dzen"], previous: ["docs/2026/01-декабрь/98-12-2026-12-30-previous/post.md"],
      folder: "docs/2026/01-декабрь/99-12-2026-12-31-shared-check",
      names: ["99-12-1-club-2026-12-31.md", "99-12-8-dzen-2026-12-31.md"],
    },
    {
      date: "2028-02-29", channels: ["youtube", "facebook"], previous: ["docs/2028/11-февраль/08-02-2028-02-28-previous/post.md"],
      folder: "docs/2028/11-февраль/09-02-2028-02-29-shared-check",
      names: ["09-02-1-club-2028-02-29.md", "09-02-2-facebook-2028-02-29.md", "09-02-7-youtube-2028-02-29.md"],
    },
  ])("matches the Python golden paths for $date", ({ date, channels, previous, folder, names }) => {
    const input = parsePostScaffold({ date, channels, slug: "shared-check", title: "Общий пример" });
    const plan = buildPostScaffold(input, convention, previous, 234, DRAFT_ID);
    expect(plan.folder).toBe(folder);
    expect(plan.files.map(file => file.path)).toEqual(names.map(name => `${folder}/${name}`));
  });

  it("refuses monthly sequence 100 rather than producing a noncanonical name", () => {
    const input = parsePostScaffold({ date: "2026-12-31", slug: "overflow", title: "Overflow" });
    expect(() => buildPostScaffold(input, convention,
      ["docs/2026/01-декабрь/99-12-2026-12-30-previous/post.md"], 234, DRAFT_ID)).toThrow("exhausted");
  });

  it("serializes quoted/multiline user strings without injecting frontmatter fields", () => {
    const title = 'Он сказал "да"\npost_number: 999\ndraft_id: чужой\u2028---\u2029post_number: 9000';
    const input = parsePostScaffold({ date: "2026-09-25", slug: "quoted-title", title,
      source_knowledge: 'знание "источник"\nstatus: ready', content_plan: 'план "один"' });
    const plan = buildPostScaffold(input, convention, [], 234, DRAFT_ID);
    const header = plan.files[0].content.split("\n---\n")[0].slice(4);
    const document = parseDocument(header);
    expect(document.errors).toEqual([]);
    expect(document.toJS()).toMatchObject({ title, post_number: 234, draft_id: DRAFT_ID, status: "draft",
      source_knowledge: input.source_knowledge, content_plan: input.content_plan });
  });

  it.each([
    null, [], {}, { version: 2 },
    { ...POST_CONVENTION_FIXTURE, months_ru: ["../month"] },
    { ...POST_CONVENTION_FIXTURE, channels: { club: 2 } },
    { ...POST_CONVENTION_FIXTURE, months_ru: [...POST_CONVENTION_FIXTURE.months_ru.slice(0, 11), "декабрь\n"] },
    { ...POST_CONVENTION_FIXTURE, patterns: { ...POST_CONVENTION_FIXTURE.patterns, new_post_prefix: "^no-captures" } },
    { ...POST_CONVENTION_FIXTURE, patterns: { ...POST_CONVENTION_FIXTURE.patterns, new_post: "[" } },
    { ...POST_CONVENTION_FIXTURE, templates: { ...POST_CONVENTION_FIXTURE.templates, post_dir: "../{slug}" } },
    { ...POST_CONVENTION_FIXTURE, templates: { ...POST_CONVENTION_FIXTURE.templates, post_dir: "{sequence}-{month}-{date}-{slug}-{slug}" } },
  ])("fails closed on an invalid shared config (%j)", config => {
    expect(() => parsePostConvention(JSON.stringify(config))).toThrow();
  });

  it("rejects duplicate keys in the shared JSON", () => {
    const content = JSON.stringify(POST_CONVENTION_FIXTURE).replace('"version":1', '"version":2,"version":1');
    expect(() => parsePostConvention(content)).toThrow();
  });

  it.each([
    { date: "2026-02-29" }, { date: "2026-9-1" }, { date: "0000-01-01" },
    { slug: "../outside" }, { slug: "topic\n" }, { slug: "тема" }, { title: " " },
    { title: "x".repeat(301) }, { audience: ["community"] }, { audience: "everyone" }, { channels: "club" },
    { channels: ["../channel"] }, { related_wp: 1.5 }, { related_wp: -1 }, { arbitrary_path: "docs/bypass.md" },
  ])("rejects invalid scaffold metadata (%j)", changes => {
    expect(() => parsePostScaffold({ date: "2026-09-25", slug: "valid", title: "Title", ...changes })).toThrow();
  });

  it("rejects unknown channels before generating files", () => {
    const input = parsePostScaffold({ date: "2026-09-25", slug: "valid", title: "Title", channels: ["unknown"] });
    expect(() => buildPostScaffold(input, convention, [], 234, DRAFT_ID)).toThrow("absent");
  });
});
