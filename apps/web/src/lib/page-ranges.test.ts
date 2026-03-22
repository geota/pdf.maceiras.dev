import { describe, it, expect } from "vitest";
import {
  resolveIndex,
  parseSlice,
  parseGroupSegment,
  parseFullExpression,
  groupToText,
  removePageFromSegmentText,
  compactSegment,
} from "./page-ranges";

// All page indices in results are 0-based. Input syntax is 1-based.
// maxPage = 10 means pages 1..10 (0-indexed: 0..9).

describe("resolveIndex", () => {
  it("positive index unchanged", () => {
    expect(resolveIndex(3, 10)).toBe(3);
  });
  it("-1 resolves to last page", () => {
    expect(resolveIndex(-1, 10)).toBe(10);
  });
  it("-2 resolves to second-to-last", () => {
    expect(resolveIndex(-2, 10)).toBe(9);
  });
  it("-10 resolves to first page", () => {
    expect(resolveIndex(-10, 10)).toBe(1);
  });
});

describe("parseSlice", () => {
  const MAX = 10;

  describe("basic forward slices", () => {
    it("1:3 → pages 1,2 (0-indexed: 0,1)", () => {
      expect(parseSlice("1:3", MAX)).toEqual([0, 1]);
    });
    it("1:2 → page 1 only", () => {
      expect(parseSlice("1:2", MAX)).toEqual([0]);
    });
    it(":: → all pages in order", () => {
      expect(parseSlice("::", MAX)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    it("::1 → all pages in order", () => {
      expect(parseSlice("::1", MAX)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    it(":3 → pages 1,2 (stop defaults exclusive)", () => {
      expect(parseSlice(":3", MAX)).toEqual([0, 1]);
    });
    it("3: → pages 3 through 10", () => {
      expect(parseSlice("3:", MAX)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe("forward with step", () => {
    it("::2 → every other page starting at 1", () => {
      expect(parseSlice("::2", MAX)).toEqual([0, 2, 4, 6, 8]); // pages 1,3,5,7,9
    });
    it("2::2 → every even page", () => {
      expect(parseSlice("2::2", MAX)).toEqual([1, 3, 5, 7, 9]); // pages 2,4,6,8,10
    });
    it("1:10:3 → pages 1,4,7", () => {
      expect(parseSlice("1:10:3", MAX)).toEqual([0, 3, 6]); // pages 1,4,7
    });
  });

  describe("reverse with negative step", () => {
    it("::-1 → all pages reversed", () => {
      expect(parseSlice("::-1", MAX)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
    it("::-2 → reverse, every second element", () => {
      expect(parseSlice("::-2", MAX)).toEqual([9, 7, 5, 3, 1]); // pages 10,8,6,4,2
    });
    it("5:2:-1 → pages 5,4,3 (0-indexed: 4,3,2)", () => {
      expect(parseSlice("5:2:-1", MAX)).toEqual([4, 3, 2]);
    });
    it("10:1:-1 → pages 10 down to 2", () => {
      expect(parseSlice("10:1:-1", MAX)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });
    it("10::-1 → all pages reversed (stop defaults to 0)", () => {
      expect(parseSlice("10::-1", MAX)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
  });

  describe("negative indices", () => {
    it("-1 resolves to last page (10)", () => {
      // -1:-4:-1 → start=10, stop=7, step=-1 → pages 10,9,8
      expect(parseSlice("-1:-4:-1", MAX)).toEqual([9, 8, 7]);
    });
    it("-3: → last 3 pages forward", () => {
      // -3 resolves to 8, stop defaults to 11
      expect(parseSlice("-3:", MAX)).toEqual([7, 8, 9]); // pages 8,9,10
    });
    it(":-3 → pages 1 through 7 (stop=-3 → 8, exclusive)", () => {
      expect(parseSlice(":-3", MAX)).toEqual([0, 1, 2, 3, 4, 5, 6]); // pages 1-7
    });
    it("-5:-2 → pages 6,7,8", () => {
      // -5 → 6, -2 → 9, step=1
      expect(parseSlice("-5:-2", MAX)).toEqual([5, 6, 7]); // pages 6,7,8
    });
    it("-1:-6:-2 → pages 10,8,6", () => {
      // -1 → 10, -6 → 5, step=-2
      expect(parseSlice("-1:-6:-2", MAX)).toEqual([9, 7, 5]); // pages 10,8,6
    });
  });

  describe("edge cases", () => {
    it("step=0 returns null", () => {
      expect(parseSlice("1:5:0", MAX)).toBeNull();
    });
    it("single number (no colon) is not a valid slice", () => {
      expect(parseSlice("5", MAX)).toBeNull();
    });
    it("empty result for impossible range", () => {
      expect(parseSlice("5:3", MAX)).toEqual([]); // forward step can't go 5→3
    });
    it("empty result for impossible reverse range", () => {
      expect(parseSlice("3:5:-1", MAX)).toEqual([]); // reverse step can't go 3→5
    });
  });
});

describe("parseGroupSegment", () => {
  const MAX = 20;

  describe("single pages", () => {
    it("single page: 5", () => {
      expect(parseGroupSegment("5", MAX)).toEqual([4]);
    });
    it("first page: 1", () => {
      expect(parseGroupSegment("1", MAX)).toEqual([0]);
    });
    it("last page: 20", () => {
      expect(parseGroupSegment("20", MAX)).toEqual([19]);
    });
  });

  describe("basic ranges (dash syntax)", () => {
    it("range: 1-3", () => {
      expect(parseGroupSegment("1-3", MAX)).toEqual([0, 1, 2]);
    });
    it("range: 1-1 → single page", () => {
      expect(parseGroupSegment("1-1", MAX)).toEqual([0]);
    });
    it("full range: 1-20", () => {
      expect(parseGroupSegment("1-20", MAX)).toEqual(
        Array.from({ length: 20 }, (_, i) => i)
      );
    });
    it("range with spaces: 3 - 7", () => {
      expect(parseGroupSegment("3 - 7", MAX)).toEqual([2, 3, 4, 5, 6]);
    });
  });

  describe("+ join syntax", () => {
    it("two single pages: 1+5", () => {
      expect(parseGroupSegment("1+5", MAX)).toEqual([0, 4]);
    });
    it("range + single: 1-3+5", () => {
      expect(parseGroupSegment("1-3+5", MAX)).toEqual([0, 1, 2, 4]);
    });
    it("single + range: 5+7-10", () => {
      expect(parseGroupSegment("5+7-10", MAX)).toEqual([4, 6, 7, 8, 9]);
    });
    it("three parts: 1+5+10", () => {
      expect(parseGroupSegment("1+5+10", MAX)).toEqual([0, 4, 9]);
    });
    it("range + range: 1-3+7-9", () => {
      expect(parseGroupSegment("1-3+7-9", MAX)).toEqual([0, 1, 2, 6, 7, 8]);
    });
    it("+ with spaces: 1 + 3 + 5", () => {
      expect(parseGroupSegment("1 + 3 + 5", MAX)).toEqual([0, 2, 4]);
    });
    it("duplicate pages via +: 3+3", () => {
      // Pages can appear multiple times — array preserves all
      expect(parseGroupSegment("3+3", MAX)).toEqual([2, 2]);
    });
    it("overlapping ranges via +: 1-5+3-7", () => {
      expect(parseGroupSegment("1-5+3-7", MAX)).toEqual([0, 1, 2, 3, 4, 2, 3, 4, 5, 6]);
    });
  });

  describe("+ with slices", () => {
    it("slice: 1:10:2", () => {
      expect(parseGroupSegment("1:10:2", MAX)).toEqual([0, 2, 4, 6, 8]);
    });
    it("mixed: range + slice: 1-3+10:20:3", () => {
      expect(parseGroupSegment("1-3+10:20:3", MAX)).toEqual([0, 1, 2, 9, 12, 15, 18]);
    });
    it("reverse slice in group: 5:2:-1", () => {
      expect(parseGroupSegment("5:2:-1", MAX)).toEqual([4, 3, 2]);
    });
    it("slice + single: ::5+20", () => {
      // ::5 → pages 1,6,11,16 → [0,5,10,15], then page 20 → [19]
      expect(parseGroupSegment("::5+20", MAX)).toEqual([0, 5, 10, 15, 19]);
    });
    it("reverse slice + forward range: 5:1:-1+10-12", () => {
      expect(parseGroupSegment("5:1:-1+10-12", MAX)).toEqual([4, 3, 2, 1, 9, 10, 11]);
    });
  });

  describe("validation", () => {
    it("page 0 returns null", () => {
      expect(parseGroupSegment("0", MAX)).toBeNull();
    });
    it("page beyond max returns null", () => {
      expect(parseGroupSegment("21", MAX)).toBeNull();
    });
    it("reversed range (end < start) returns null", () => {
      expect(parseGroupSegment("5-3", MAX)).toBeNull();
    });
    it("non-numeric returns null", () => {
      expect(parseGroupSegment("abc", MAX)).toBeNull();
    });
    it("empty string returns empty array", () => {
      expect(parseGroupSegment("", MAX)).toEqual([]);
    });
  });
});

describe("parseFullExpression", () => {
  const MAX = 20;

  describe("single group basics", () => {
    it("single page: 5", () => {
      expect(parseFullExpression("5", MAX)).toEqual([[4]]);
    });
    it("basic range: 1-3", () => {
      expect(parseFullExpression("1-3", MAX)).toEqual([[0, 1, 2]]);
    });
    it("single page range: 1-1", () => {
      expect(parseFullExpression("1-1", MAX)).toEqual([[0]]);
    });
    it("+ within single group: 1-3+5", () => {
      expect(parseFullExpression("1-3+5", MAX)).toEqual([[0, 1, 2, 4]]);
    });
    it("multiple + in single group: 1+5+10+15", () => {
      expect(parseFullExpression("1+5+10+15", MAX)).toEqual([[0, 4, 9, 14]]);
    });
    it("range + range in single group: 1-3+8-10", () => {
      expect(parseFullExpression("1-3+8-10", MAX)).toEqual([[0, 1, 2, 7, 8, 9]]);
    });
  });

  describe("multiple groups (comma-separated)", () => {
    it("two groups: 1-3, 5-7", () => {
      expect(parseFullExpression("1-3, 5-7", MAX)).toEqual([
        [0, 1, 2],
        [4, 5, 6],
      ]);
    });
    it("three groups: 1-3, 5, 10-12", () => {
      expect(parseFullExpression("1-3, 5, 10-12", MAX)).toEqual([
        [0, 1, 2],
        [4],
        [9, 10, 11],
      ]);
    });
    it("many single-page groups: 1, 3, 5, 7", () => {
      expect(parseFullExpression("1, 3, 5, 7", MAX)).toEqual([
        [0], [2], [4], [6],
      ]);
    });
    it("groups with + inside: 1-3+5, 7+9-11, 15", () => {
      expect(parseFullExpression("1-3+5, 7+9-11, 15", MAX)).toEqual([
        [0, 1, 2, 4],
        [6, 8, 9, 10],
        [14],
      ]);
    });
    it("no spaces around comma: 1-3,5-7", () => {
      expect(parseFullExpression("1-3,5-7", MAX)).toEqual([
        [0, 1, 2],
        [4, 5, 6],
      ]);
    });
    it("extra spaces: 1 - 3 , 5 - 7", () => {
      expect(parseFullExpression("1 - 3 , 5 - 7", MAX)).toEqual([
        [0, 1, 2],
        [4, 5, 6],
      ]);
    });
  });

  describe("pages in multiple groups (overlapping)", () => {
    it("same page in two groups: 1-5, 3-7", () => {
      // Pages 3,4,5 appear in both groups — this is allowed
      expect(parseFullExpression("1-5, 3-7", MAX)).toEqual([
        [0, 1, 2, 3, 4],
        [2, 3, 4, 5, 6],
      ]);
    });
    it("identical groups: 1-3, 1-3", () => {
      expect(parseFullExpression("1-3, 1-3", MAX)).toEqual([
        [0, 1, 2],
        [0, 1, 2],
      ]);
    });
    it("single page in multiple groups: 5, 5, 5", () => {
      expect(parseFullExpression("5, 5, 5", MAX)).toEqual([
        [4], [4], [4],
      ]);
    });
    it("partial overlap: 1-10, 5-15, 10-20", () => {
      expect(parseFullExpression("1-10, 5-15, 10-20", MAX)).toEqual([
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      ]);
    });
    it("all pages in every group: 1-20, 1-20", () => {
      const allPages = Array.from({ length: 20 }, (_, i) => i);
      expect(parseFullExpression("1-20, 1-20", MAX)).toEqual([allPages, allPages]);
    });
  });

  describe("slices as groups", () => {
    it("odd/even split: ::2, 2::2", () => {
      expect(parseFullExpression("::2, 2::2", MAX)).toEqual([
        [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
        [1, 3, 5, 7, 9, 11, 13, 15, 17, 19],
      ]);
    });
    it("reverse slice as a group: ::-1", () => {
      const result = parseFullExpression("::-1", MAX)!;
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
    });
    it("negative indices: -1:-4:-1", () => {
      expect(parseFullExpression("-1:-4:-1", MAX)).toEqual([[19, 18, 17]]);
    });
  });

  describe("complex mixed expressions", () => {
    it("range + slice in same group, separate group: 1-3+::-2, -1:-4:-1+15", () => {
      const result = parseFullExpression("1-3+::-2, -1:-4:-1+15", MAX)!;
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([0, 1, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1]);
      expect(result[1]).toEqual([19, 18, 17, 14]);
    });
    it("forward group + reversed group: 1-5, 5::-1", () => {
      expect(parseFullExpression("1-5, 5::-1", MAX)).toEqual([
        [0, 1, 2, 3, 4],
        [4, 3, 2, 1, 0],
      ]);
    });
    it("every 3rd page in separate groups: 1::3, 2::3, 3::3", () => {
      expect(parseFullExpression("1::3, 2::3, 3::3", MAX)).toEqual([
        [0, 3, 6, 9, 12, 15, 18],  // pages 1,4,7,10,13,16,19
        [1, 4, 7, 10, 13, 16, 19], // pages 2,5,8,11,14,17,20
        [2, 5, 8, 11, 14, 17],     // pages 3,6,9,12,15,18
      ]);
    });
  });

  describe("edge cases", () => {
    it("empty groups are skipped", () => {
      expect(parseFullExpression(", 1-3, , 5", MAX)).toEqual([
        [0, 1, 2],
        [4],
      ]);
    });
    it("empty string returns empty array", () => {
      expect(parseFullExpression("", MAX)).toEqual([]);
    });
    it("whitespace only returns empty array", () => {
      expect(parseFullExpression("   ", MAX)).toEqual([]);
    });
    it("invalid returns null", () => {
      expect(parseFullExpression("abc", MAX)).toBeNull();
    });
    it("partially invalid returns null", () => {
      expect(parseFullExpression("1-3, abc", MAX)).toBeNull();
    });
    it("single page doc: page 1 only", () => {
      expect(parseFullExpression("1", 1)).toEqual([[0]]);
      expect(parseFullExpression("2", 1)).toBeNull();
    });
  });
});

describe("groupToText", () => {
  it("empty array", () => {
    expect(groupToText([])).toBe("");
  });
  it("single page", () => {
    expect(groupToText([4])).toBe("5");
  });
  it("consecutive ascending → range", () => {
    expect(groupToText([0, 1, 2])).toBe("1-3");
  });
  it("non-contiguous → joined with +", () => {
    expect(groupToText([0, 1, 2, 4])).toBe("1-3+5");
  });
  it("reversed pages → individual + separated", () => {
    expect(groupToText([4, 3, 2])).toBe("5+4+3");
  });
  it("mixed ascending runs and singles", () => {
    expect(groupToText([0, 1, 2, 5, 6, 9])).toBe("1-3+6-7+10");
  });
  it("duplicate pages preserved", () => {
    expect(groupToText([0, 0, 1])).toBe("1+1-2");
  });
  it("two separate ranges", () => {
    expect(groupToText([0, 1, 2, 6, 7, 8])).toBe("1-3+7-9");
  });
  it("all individual pages", () => {
    expect(groupToText([0, 5, 9])).toBe("1+6+10");
  });
  it("descending then ascending", () => {
    expect(groupToText([9, 8, 7, 0, 1, 2])).toBe("10+9+8+1-3");
  });
  it("round-trip: parse then format", () => {
    const parsed = [0, 1, 2, 4, 6, 7, 8]; // "1-3+5+7-9"
    expect(groupToText(parsed)).toBe("1-3+5+7-9");
  });
});

describe("removePageFromSegmentText", () => {
  const MAX = 20;

  describe("removing from single pages", () => {
    it("remove the only page: '5' remove 5", () => {
      expect(removePageFromSegmentText("5", 4, MAX, [])).toBe("");
    });
    it("remove first of two singles: '3+7' remove 3", () => {
      expect(removePageFromSegmentText("3+7", 2, MAX, [6])).toBe("7");
    });
    it("remove second of two singles: '3+7' remove 7", () => {
      expect(removePageFromSegmentText("3+7", 6, MAX, [2])).toBe("3");
    });
  });

  describe("removing from ranges", () => {
    it("remove middle of range: '3-8' remove 5 → '3-4+6-8'", () => {
      expect(removePageFromSegmentText("3-8", 4, MAX, [2, 3, 5, 6, 7])).toBe("3-4+6-8");
    });
    it("remove start of range: '3-8' remove 3 → '4-8'", () => {
      expect(removePageFromSegmentText("3-8", 2, MAX, [3, 4, 5, 6, 7])).toBe("4-8");
    });
    it("remove end of range: '3-8' remove 8 → '3-7'", () => {
      expect(removePageFromSegmentText("3-8", 7, MAX, [2, 3, 4, 5, 6])).toBe("3-7");
    });
    it("remove from 2-page range start: '3-4' remove 3 → '4'", () => {
      expect(removePageFromSegmentText("3-4", 2, MAX, [3])).toBe("4");
    });
    it("remove from 2-page range end: '3-4' remove 4 → '3'", () => {
      expect(removePageFromSegmentText("3-4", 3, MAX, [2])).toBe("3");
    });
    it("remove second-to-last from range: '3-8' remove 7 → '3-6+8'", () => {
      expect(removePageFromSegmentText("3-8", 6, MAX, [2, 3, 4, 5, 7])).toBe("3-6+8");
    });
    it("remove second from range: '3-8' remove 4 → '3+5-8'", () => {
      expect(removePageFromSegmentText("3-8", 3, MAX, [2, 4, 5, 6, 7])).toBe("3+5-8");
    });
  });

  describe("removing from compound expressions", () => {
    it("range + single, remove from range: '1-5+10' remove 3 → '1-2+4-5+10'", () => {
      expect(removePageFromSegmentText("1-5+10", 2, MAX, [0, 1, 3, 4, 9])).toBe("1-2+4-5+10");
    });
    it("range + single, remove the single: '1-5+10' remove 10 → '1-5'", () => {
      expect(removePageFromSegmentText("1-5+10", 9, MAX, [0, 1, 2, 3, 4])).toBe("1-5");
    });
    it("two ranges, remove from second: '1-3+7-9' remove 8 → '1-3+7+9'", () => {
      expect(removePageFromSegmentText("1-3+7-9", 7, MAX, [0, 1, 2, 6, 8])).toBe("1-3+7+9");
    });
  });

  describe("preserving slices", () => {
    it("slice + single, remove the single: '1:10:2+6' remove 6 → '1:10:2'", () => {
      expect(removePageFromSegmentText("1:10:2+6", 5, MAX, [0, 2, 4, 6, 8])).toBe("1:10:2");
    });
    it("slice + range, remove from range: '1:10:2+12-15' remove 13 → '1:10:2+12+14-15'", () => {
      expect(removePageFromSegmentText("1:10:2+12-15", 12, MAX, [0, 2, 4, 6, 8, 11, 13, 14]))
        .toBe("1:10:2+12+14-15");
    });
    it("range + slice, remove from range: '3-8+1:20:5' remove 5 → '3-4+6-8+1:20:5'", () => {
      expect(removePageFromSegmentText("3-8+1:20:5", 4, MAX, [2, 3, 5, 6, 7, 0, 5, 10, 15]))
        .toBe("3-4+6-8+1:20:5");
    });
  });

  describe("removing from slices (last resort — expands the slice)", () => {
    it("slice only, remove a slice page: '1:10:2' remove 3 → '1+5+7+9'", () => {
      // 1:10:2 → pages 1,3,5,7,9 (0-indexed: 0,2,4,6,8). Remove page 3 (idx 2)
      expect(removePageFromSegmentText("1:10:2", 2, MAX, [0, 4, 6, 8])).toBe("1+5+7+9");
    });
    it("slice only, remove first: '1:6' remove 1 → '2-5'", () => {
      expect(removePageFromSegmentText("1:6", 0, MAX, [1, 2, 3, 4])).toBe("2-5");
    });
  });
});

describe("compactSegment", () => {
  const MAX = 20;

  describe("no slices — sorts and merges", () => {
    it("already compact: '1-5'", () => {
      expect(compactSegment("1-5", MAX)).toBe("1-5");
    });
    it("out of order singles merge: '1+6-18+2-5' → '1-18'", () => {
      expect(compactSegment("1+6-18+2-5", MAX)).toBe("1-18");
    });
    it("overlapping ranges merge: '1-10+5-15' → '1-15'", () => {
      expect(compactSegment("1-10+5-15", MAX)).toBe("1-15");
    });
    it("adjacent ranges merge: '1-5+6-10' → '1-10'", () => {
      expect(compactSegment("1-5+6-10", MAX)).toBe("1-10");
    });
    it("scattered singles: '3+1+5+2+4' → '1-5'", () => {
      expect(compactSegment("3+1+5+2+4", MAX)).toBe("1-5");
    });
    it("duplicates removed: '3+3+3' → '3'", () => {
      expect(compactSegment("3+3+3", MAX)).toBe("3");
    });
    it("gap preserved: '1-3+7-9' stays as '1-3+7-9'", () => {
      expect(compactSegment("1-3+7-9", MAX)).toBe("1-3+7-9");
    });
    it("single page unchanged: '5'", () => {
      expect(compactSegment("5", MAX)).toBe("5");
    });
    it("empty string", () => {
      expect(compactSegment("", MAX)).toBe("");
    });
  });

  describe("with slices — keeps slices, compacts non-slice parts", () => {
    it("slice only: '1:10:2' unchanged", () => {
      expect(compactSegment("1:10:2", MAX)).toBe("1:10:2");
    });
    it("slice + redundant page: '1:10:2+3' → '1:10:2' (3 already in slice)", () => {
      // 1:10:2 produces pages 1,3,5,7,9 — page 3 is already covered
      expect(compactSegment("1:10:2+3", MAX)).toBe("1:10:2");
    });
    it("slice + new page: '1:10:2+6' → '1:10:2+6'", () => {
      expect(compactSegment("1:10:2+6", MAX)).toBe("1:10:2+6");
    });
    it("slice + scattered pages compact: '1:10:2+4+2+6' → '1:10:2+2+4+6'", () => {
      // 1:10:2 covers 1,3,5,7,9. Non-slice adds 4,2,6. After dedup+sort: 2,4,6
      expect(compactSegment("1:10:2+4+2+6", MAX)).toBe("1:10:2+2+4+6");
    });
    it("slice + adjacent pages merge: '1:10:2+10+11+12' → '1:10:2+10-12'", () => {
      expect(compactSegment("1:10:2+10+11+12", MAX)).toBe("1:10:2+10-12");
    });
    it("two slices: '1:10:2+2:10:2' stays", () => {
      expect(compactSegment("1:10:2+2:10:2", MAX)).toBe("1:10:2+2:10:2");
    });
  });
});

// Tests for reorder-style usage of parseGroupSegment + groupToText.
// Reorder uses a single group (no commas) where order = output page order.
describe("reorder expressions", () => {
  const MAX = 10;

  describe("parseGroupSegment for reorder", () => {
    it("identity: '1-10' → all pages in order", () => {
      expect(parseGroupSegment("1-10", MAX)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    it("reverse: '::-1' → all pages reversed", () => {
      expect(parseGroupSegment("::-1", MAX)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
    it("odd then even: '::2+2::2'", () => {
      expect(parseGroupSegment("::2+2::2", MAX)).toEqual([
        0, 2, 4, 6, 8,  // odd pages: 1,3,5,7,9
        1, 3, 5, 7, 9,  // even pages: 2,4,6,8,10
      ]);
    });
    it("partial reverse then forward: '5:1:-1+6-10'", () => {
      expect(parseGroupSegment("5:1:-1+6-10", MAX)).toEqual([
        4, 3, 2, 1,      // pages 5,4,3,2
        5, 6, 7, 8, 9,   // pages 6-10
      ]);
    });
    it("subset: '1-5' drops pages 6-10", () => {
      expect(parseGroupSegment("1-5", MAX)).toEqual([0, 1, 2, 3, 4]);
    });
    it("duplicate pages: '1-3+1-3' → pages appear twice", () => {
      expect(parseGroupSegment("1-3+1-3", MAX)).toEqual([0, 1, 2, 0, 1, 2]);
    });
    it("single page: '5'", () => {
      expect(parseGroupSegment("5", MAX)).toEqual([4]);
    });
    it("reverse subset: '5:2:-1'", () => {
      expect(parseGroupSegment("5:2:-1", MAX)).toEqual([4, 3, 2]);
    });
    it("every third page: '1::3'", () => {
      expect(parseGroupSegment("1::3", MAX)).toEqual([0, 3, 6, 9]); // pages 1,4,7,10
    });
    it("reverse every other: '::-2'", () => {
      expect(parseGroupSegment("::-2", MAX)).toEqual([9, 7, 5, 3, 1]); // pages 10,8,6,4,2
    });
    it("interleave front and back: '1+10+2+9+3+8+4+7+5+6'", () => {
      expect(parseGroupSegment("1+10+2+9+3+8+4+7+5+6", MAX)).toEqual([
        0, 9, 1, 8, 2, 7, 3, 6, 4, 5,
      ]);
    });
    it("negative indices: '-1:-4:-1' → last 3 pages reversed", () => {
      expect(parseGroupSegment("-1:-4:-1", MAX)).toEqual([9, 8, 7]);
    });
    it("last 3 then first 3: '-3:+1:4'", () => {
      // -3: → pages 8,9,10 (idx 7,8,9), 1:4 → pages 1,2,3 (idx 0,1,2)
      expect(parseGroupSegment("-3:+1:4", MAX)).toEqual([7, 8, 9, 0, 1, 2]);
    });
  });

  describe("groupToText for reorder results", () => {
    it("identity order compacts to range", () => {
      expect(groupToText([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe("1-10");
    });
    it("reversed order is individual pages", () => {
      expect(groupToText([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])).toBe("10+9+8+7+6+5+4+3+2+1");
    });
    it("odd then even", () => {
      expect(groupToText([0, 2, 4, 6, 8, 1, 3, 5, 7, 9]))
        .toBe("1+3+5+7+9+2+4+6+8+10");
    });
    it("partial reverse then forward", () => {
      expect(groupToText([4, 3, 2, 1, 5, 6, 7, 8, 9])).toBe("5+4+3+2+6-10");
    });
    it("subset compacts", () => {
      expect(groupToText([0, 1, 2, 3, 4])).toBe("1-5");
    });
    it("duplicated pages", () => {
      expect(groupToText([0, 1, 2, 0, 1, 2])).toBe("1-3+1-3");
    });
    it("single page after drag", () => {
      // e.g. moved page 5 to front: [4, 0, 1, 2, 3, 5, 6, 7, 8, 9]
      expect(groupToText([4, 0, 1, 2, 3, 5, 6, 7, 8, 9])).toBe("5+1-4+6-10");
    });
    it("swapped first and last", () => {
      expect(groupToText([9, 1, 2, 3, 4, 5, 6, 7, 8, 0])).toBe("10+2-9+1");
    });
  });

  describe("round-trip: apply then display", () => {
    it("::-1 apply then groupToText", () => {
      const pages = parseGroupSegment("::-1", MAX)!;
      // reversed pages won't compact back to ::-1, but should be valid
      const text = groupToText(pages);
      expect(text).toBe("10+9+8+7+6+5+4+3+2+1");
      // Re-parsing should give same pages
      expect(parseGroupSegment(text, MAX)).toEqual(pages);
    });
    it("::2+2::2 round-trip", () => {
      const pages = parseGroupSegment("::2+2::2", MAX)!;
      const text = groupToText(pages);
      expect(parseGroupSegment(text, MAX)).toEqual(pages);
    });
    it("5:1:-1+6-10 round-trip", () => {
      const pages = parseGroupSegment("5:1:-1+6-10", MAX)!;
      const text = groupToText(pages);
      expect(parseGroupSegment(text, MAX)).toEqual(pages);
    });
    it("identity round-trip", () => {
      const pages = parseGroupSegment("1-10", MAX)!;
      expect(groupToText(pages)).toBe("1-10");
      expect(parseGroupSegment("1-10", MAX)).toEqual(pages);
    });
  });

  describe("validation for reorder", () => {
    it("page beyond max returns null", () => {
      expect(parseGroupSegment("1-11", MAX)).toBeNull();
    });
    it("page 0 returns null", () => {
      expect(parseGroupSegment("0-5", MAX)).toBeNull();
    });
    it("non-numeric returns null", () => {
      expect(parseGroupSegment("abc", MAX)).toBeNull();
    });
    it("empty is allowed (empty array)", () => {
      expect(parseGroupSegment("", MAX)).toEqual([]);
    });
  });
});
