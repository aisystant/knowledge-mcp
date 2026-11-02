import { describe, it, expect } from "vitest";
import { planPrune, PRUNE_MAX_RATIO } from "./full-ingest-prune.js";

const fileList = (n: number, prefix = "DPFs/f") => Array.from({ length: n }, (_, i) => `${prefix}${i}.md`);

describe("planPrune (WP-596 Ф14)", () => {
  it("plans nothing when the index and the tree agree", () => {
    const files = fileList(10);
    expect(planPrune(files, files)).toEqual({ toDelete: [], blocked: false, missingRatio: 0 });
  });

  it("plans the files that left the tree", () => {
    const tree = fileList(10);
    const plan = planPrune([...tree, "Old/gone.md"], tree);
    expect(plan.toDelete).toEqual(["Old/gone.md"]);
    expect(plan.blocked).toBe(false);
  });

  it("keeps an oversized file that is in the tree", () => {
    // FPF-Spec.md is over the size prefilter, so it is not in the "eligible" list but it is in the tree.
    const tree = [...fileList(9), "FPF-Spec.md"];
    expect(planPrune(tree, tree).toDelete).toEqual([]);
  });

  it("blocks a folder move that touches more than the limit", () => {
    // 13.10: a whole folder moved, old paths are 51 of 101 indexed files.
    const moved = fileList(51, "Engineering DPF Suite/f");
    const kept = fileList(50, "DPFs/f");
    const plan = planPrune([...moved, ...kept], kept);
    expect(plan.blocked).toBe(true);
    expect(plan.toDelete).toEqual([]);
    expect(plan.missingRatio).toBeCloseTo(51 / 101);
  });

  it("allows the same move with a raised limit", () => {
    const moved = fileList(51, "Engineering DPF Suite/f");
    const kept = fileList(50, "DPFs/f");
    const plan = planPrune([...moved, ...kept], kept, 0.6);
    expect(plan.blocked).toBe(false);
    expect(plan.toDelete).toEqual(moved);
  });

  it("blocks an empty tree instead of wiping the source", () => {
    const plan = planPrune(fileList(5), []);
    expect(plan.blocked).toBe(true);
    expect(plan.toDelete).toEqual([]);
  });

  it("does nothing for an empty index", () => {
    expect(planPrune([], fileList(5))).toEqual({ toDelete: [], blocked: false, missingRatio: 0 });
  });

  it("allows exactly the limit", () => {
    const tree = fileList(8);
    const plan = planPrune([...tree, "a.md", "b.md"], tree, PRUNE_MAX_RATIO);
    expect(plan.blocked).toBe(false);
    expect(plan.toDelete).toEqual(["a.md", "b.md"]);
  });
});
