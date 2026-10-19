import { isMap, isScalar, parseDocument } from "yaml";
import { utf8ByteLength } from "./path-tree.js";

export const POST_CONVENTION_PATH = "scripts/_publish_convention.json";

export class PostScaffoldError extends Error {
  constructor(readonly reason: "invalid_scaffold" | "invalid_post_convention" | "scaffold_conflict", message: string) {
    super(message);
  }
}

export interface PostScaffoldInput {
  date: string;
  slug: string;
  title: string;
  audience: "wide" | "community" | "advanced";
  channels: string[];
  source_knowledge: string | null;
  content_plan: string;
  related_wp?: number;
}

type PatternName = "slug" | "month_dir" | "new_post_prefix" | "new_post" | "legacy_post" | "legacy_alt_post" | "service";
type TemplateName = "month_dir" | "post_dir" | "channel_file";

export interface PostConvention {
  version: 1;
  reverse_month_base: number;
  months_ru: string[];
  channels: Record<string, number>;
  patterns: Record<PatternName, string>;
  templates: Record<TemplateName, string>;
  non_month_dirs: string[];
}

export interface PostScaffoldFile {
  path: string;
  content: string;
}

export interface PostScaffoldPlan {
  folder: string;
  files: PostScaffoldFile[];
}

function record(value: unknown, reason: PostScaffoldError["reason"]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PostScaffoldError(reason, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], reason: PostScaffoldError["reason"]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new PostScaffoldError(reason, "Unexpected or missing convention fields.");
  }
}

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) {
    throw new PostScaffoldError("invalid_scaffold", `Invalid scaffold field: ${name}.`);
  }
  return value;
}

export function parsePostScaffold(value: unknown): PostScaffoldInput {
  const input = record(value, "invalid_scaffold");
  const allowed = ["date", "slug", "title", "audience", "channels", "source_knowledge", "content_plan", "related_wp"];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new PostScaffoldError("invalid_scaffold", "Unknown scaffold field.");
  }
  const date = text(input.date, "date", 10);
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || date.startsWith("0000")
    || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new PostScaffoldError("invalid_scaffold", "date must be a real calendar date YYYY-MM-DD.");
  }
  const slug = text(input.slug, "slug", 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || /[\r\n]/.test(slug)) {
    throw new PostScaffoldError("invalid_scaffold", "slug must use lowercase ASCII letters, digits and hyphens.");
  }
  const title = text(input.title, "title", 300);
  if (!title.trim()) throw new PostScaffoldError("invalid_scaffold", "title must not be empty.");
  const audience = input.audience ?? "community";
  if (typeof audience !== "string" || !["wide", "community", "advanced"].includes(audience)) {
    throw new PostScaffoldError("invalid_scaffold", "Unknown audience.");
  }
  const channels = input.channels ?? ["club"];
  if (!Array.isArray(channels) || channels.length > 16 || channels.some(channel =>
    typeof channel !== "string" || !/^[a-z][a-z0-9]*$/.test(channel) || /[\r\n]/.test(channel))) {
    throw new PostScaffoldError("invalid_scaffold", "channels must be a short array of channel names.");
  }
  if (input.related_wp !== undefined && (typeof input.related_wp !== "number"
    || !Number.isSafeInteger(input.related_wp) || input.related_wp < 1)) {
    throw new PostScaffoldError("invalid_scaffold", "related_wp must be a positive integer.");
  }
  return {
    date, slug, title, audience: audience as PostScaffoldInput["audience"], channels: [...new Set(["club", ...channels])],
    source_knowledge: input.source_knowledge == null ? null : text(input.source_knowledge, "source_knowledge", 1000) || null,
    content_plan: input.content_plan == null ? "" : text(input.content_plan, "content_plan", 1000),
    ...(input.related_wp === undefined ? {} : { related_wp: input.related_wp as number }),
  };
}

export function parsePostConvention(content: string): PostConvention {
  const reason = "invalid_post_convention";
  if (utf8ByteLength(content) > 65_536) throw new PostScaffoldError(reason, "Publication convention exceeds 64 KiB.");
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(content), reason);
    if (parseDocument(content, { uniqueKeys: true, schema: "json" }).errors.length) throw new Error("Duplicate JSON keys");
  } catch {
    throw new PostScaffoldError(reason, "Publication convention is not unambiguous JSON.");
  }
  exactKeys(value, ["version", "reverse_month_base", "months_ru", "channels", "patterns", "templates", "non_month_dirs"], reason);
  if (value.version !== 1 || value.reverse_month_base !== 13 || !Array.isArray(value.months_ru)
    || value.months_ru.length !== 12 || new Set(value.months_ru).size !== 12
    || value.months_ru.some(month => typeof month !== "string" || !/^[а-яё]+$/.test(month) || /[\r\n]/.test(month))) {
    throw new PostScaffoldError(reason, "Unsupported convention version or month registry.");
  }
  const channels = record(value.channels, reason);
  const numbers = Object.values(channels);
  if (channels.club !== 1 || numbers.length > 16 || Object.keys(channels).some(channel => !/^[a-z][a-z0-9]*$/.test(channel) || /[\r\n]/.test(channel))
    || numbers.some(number => typeof number !== "number" || !Number.isSafeInteger(number))
    || [...numbers as number[]].sort((a, b) => a - b).some((number, index) => number !== index + 1)) {
    throw new PostScaffoldError(reason, "Invalid channel registry.");
  }
  const patterns = record(value.patterns, reason);
  exactKeys(patterns, ["slug", "month_dir", "new_post_prefix", "new_post", "legacy_post", "legacy_alt_post", "service"], reason);
  const patternGroups: Record<PatternName, number> = {
    slug: 0, month_dir: 2, new_post_prefix: 2, new_post: 0, legacy_post: 0, legacy_alt_post: 0, service: 0,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    if (typeof pattern !== "string" || !pattern.length || pattern.length > 512 || !pattern.startsWith("^")
      || (name !== "new_post_prefix" && !pattern.endsWith("$"))) {
      throw new PostScaffoldError(reason, "Invalid naming pattern.");
    }
    try {
      // The empty alternative observes the declared capture count without running
      // a repository-controlled expression against any potentially long filename.
      const groups = new RegExp(`(?:${pattern})|`).exec("")!.length - 1;
      if (groups !== patternGroups[name as PatternName]) throw new Error("Wrong capture count");
    } catch { throw new PostScaffoldError(reason, "Invalid naming pattern or capture groups."); }
  }
  const templates = record(value.templates, reason);
  const fields: Record<TemplateName, string[]> = {
    month_dir: ["reverse_month", "month_name"], post_dir: ["sequence", "month", "date", "slug"],
    channel_file: ["sequence", "month", "channel_number", "channel", "date"],
  };
  exactKeys(templates, Object.keys(fields), reason);
  for (const name of Object.keys(fields) as TemplateName[]) {
    const template = templates[name];
    if (typeof template !== "string" || template.length > 255 || /[/\\\0]/.test(template)) {
      throw new PostScaffoldError(reason, "Invalid naming template.");
    }
    const placeholders = [...template.matchAll(/\{([a-z_]+)\}/g)].map(match => match[1]).sort();
    if (!/^[a-z0-9.-]*$/.test(template.replace(/\{[a-z_]+\}/g, "")) || /[\r\n]/.test(template)
      || (name === "channel_file" && !template.endsWith(".md"))
      || JSON.stringify(placeholders) !== JSON.stringify([...fields[name]].sort())) {
      throw new PostScaffoldError(reason, "Naming template placeholders do not match version 1.");
    }
  }
  if (!Array.isArray(value.non_month_dirs) || value.non_month_dirs.some(name => typeof name !== "string")
    || new Set(value.non_month_dirs).size !== value.non_month_dirs.length) {
    throw new PostScaffoldError(reason, "Invalid non-month directory registry.");
  }
  for (const name of value.non_month_dirs) component(name as string, {});
  return value as unknown as PostConvention;
}

function component(template: string, values: Record<string, string>): string {
  const result = template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => values[key]);
  if (!result || result === "." || result === ".." || !/^[a-zа-яё0-9.-]+$/.test(result) || /[\r\n]/.test(result) || utf8ByteLength(result) > 255) {
    throw new PostScaffoldError("invalid_post_convention", "Convention produced an unsafe filename component.");
  }
  return result;
}

function orderedChannels(input: PostScaffoldInput, convention: PostConvention): string[] {
  if (input.channels.some(channel => !Object.hasOwn(convention.channels, channel))) {
    throw new PostScaffoldError("invalid_scaffold", "A requested channel is absent from the publication convention.");
  }
  return [...input.channels].sort((a, b) => convention.channels[a] - convention.channels[b]);
}

function namingValues(input: PostScaffoldInput, convention: PostConvention, sequence: number): Record<string, string> {
  const month = Number(input.date.slice(5, 7));
  return { date: input.date, slug: input.slug, month: input.date.slice(5, 7), sequence: String(sequence).padStart(2, "0"),
    reverse_month: String(convention.reverse_month_base - month).padStart(2, "0"), month_name: convention.months_ru[month - 1] };
}

function frontmatter(input: PostScaffoldInput, convention: PostConvention, channel: string, number: number,
  draftId: string, clubFilename: string): Record<string, unknown> {
  return { type: "post", title: input.title, audience: input.audience, status: "draft", created: input.date,
    target: channel, channel_number: convention.channels[channel], draft_id: draftId, post_number: number,
    ...(channel === "club" ? {} : { source_post: clubFilename }), source_knowledge: input.source_knowledge,
    tags: [], content_plan: input.content_plan, ...(input.related_wp === undefined ? {} : { related_wp: input.related_wp }) };
}

export function buildPostScaffold(input: PostScaffoldInput, convention: PostConvention, paths: string[],
  number: number, draftId: string): PostScaffoldPlan {
  const values = namingValues(input, convention, 1);
  const month = component(convention.templates.month_dir, values);
  const monthMatch = new RegExp(convention.patterns.month_dir).exec(month);
  if (!monthMatch || monthMatch[1] !== values.reverse_month || monthMatch[2] !== values.month_name
    || !new RegExp(convention.patterns.slug).test(input.slug)) {
    throw new PostScaffoldError("invalid_post_convention", "Convention rejected its month name or slug.");
  }
  const monthPath = `docs/${input.date.slice(0, 4)}/${month}/`;
  const folders = new Set(paths.filter(path => path.startsWith(monthPath)).map(path => path.slice(monthPath.length).split("/")[0]));
  let sequence = 1;
  for (const folder of folders) {
    const match = new RegExp(convention.patterns.new_post_prefix).exec(folder);
    if (match && match[2] === values.month) sequence = Math.max(sequence, Number(match[1]) + 1);
  }
  if (!Number.isSafeInteger(sequence) || sequence > 99) {
    throw new PostScaffoldError("scaffold_conflict", "The two-digit monthly sequence is exhausted.");
  }
  values.sequence = String(sequence).padStart(2, "0");
  const folderName = component(convention.templates.post_dir, values);
  const prefix = new RegExp(convention.patterns.new_post_prefix).exec(folderName);
  if (!new RegExp(convention.patterns.new_post).test(folderName) || !prefix
    || prefix[1] !== values.sequence || prefix[2] !== values.month) {
    throw new PostScaffoldError("invalid_post_convention", "Convention rejected its post folder.");
  }
  const folder = monthPath + folderName;
  const fileName = (channel: string) => component(convention.templates.channel_file,
    { ...values, channel, channel_number: String(convention.channels[channel]) });
  const clubFilename = fileName("club");
  const files = orderedChannels(input, convention).map(channel => {
    const header = frontmatter(input, convention, channel, number, draftId, clubFilename);
    const content = "---\n" + Object.entries(header).map(([key, value]) => `${key}: ${JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))}`).join("\n")
      + `\n---\n\n# ${input.title}\n`;
    return { path: `${folder}/${fileName(channel)}`, content };
  });
  if (paths.some(path => path === folder || path.startsWith(folder + "/"))) {
    throw new PostScaffoldError("scaffold_conflict", "The generated publication folder already exists.");
  }
  return { folder, files };
}

export function verifyExistingScaffold(input: PostScaffoldInput, convention: PostConvention,
  clubPath: string, files: Map<string, string>, number: number, draftId: string): string[] {
  const folder = clubPath.slice(0, clubPath.lastIndexOf("/"));
  const folderName = folder.split("/").at(-1)!;
  const prefix = new RegExp(convention.patterns.new_post_prefix).exec(folderName);
  if (!prefix) throw new PostScaffoldError("scaffold_conflict", "Existing draft has an unsupported folder convention.");
  const values = namingValues(input, convention, Number(prefix[1]));
  const expectedFolder = `docs/${input.date.slice(0, 4)}/${component(convention.templates.month_dir, values)}/${component(convention.templates.post_dir, values)}`;
  if (folder !== expectedFolder) throw new PostScaffoldError("scaffold_conflict", "Draft date or slug differs from the existing publication.");
  const expected = orderedChannels(input, convention).map(channel => ({ channel,
    path: folder + "/" + component(convention.templates.channel_file,
      { ...values, channel, channel_number: String(convention.channels[channel]) }),
  }));
  const channelPaths = [...files.keys()].filter(path => path.startsWith(folder + "/") && path.endsWith(".md"));
  if (channelPaths.length !== expected.length || expected.some(file => !files.has(file.path))) {
    throw new PostScaffoldError("scaffold_conflict", "Existing draft has an incomplete or different channel set.");
  }
  for (const { channel, path } of expected) {
    const content = files.get(path)!;
    const header = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").match(/^---\s*\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/)?.[1];
    const document = parseDocument(header ?? "", { uniqueKeys: true });
    if (header === undefined || document.errors.length || document.warnings.length || !isMap(document.contents)
      || document.contents.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<")) {
      throw new PostScaffoldError("scaffold_conflict", "Existing draft has invalid frontmatter.");
    }
    let actual: Record<string, unknown>;
    try { actual = record(document.toJS({ maxAliasCount: 0 }), "scaffold_conflict"); }
    catch { throw new PostScaffoldError("scaffold_conflict", "Existing draft has ambiguous frontmatter."); }
    if (actual.related_wp !== input.related_wp) {
      throw new PostScaffoldError("scaffold_conflict", "Existing draft metadata differs: related_wp.");
    }
    const wanted = frontmatter(input, convention, channel, number, draftId, clubPath.split("/").at(-1)!);
    for (const [key, value] of Object.entries(wanted)) {
      if (key === "status" || key === "tags") continue;
      const current = key === "draft_id" && typeof actual[key] === "string" ? actual[key].toLowerCase() : actual[key];
      if (current !== value) throw new PostScaffoldError("scaffold_conflict", `Existing draft metadata differs: ${key}.`);
    }
  }
  return expected.map(file => file.path);
}
