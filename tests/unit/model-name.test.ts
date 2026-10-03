/** withDefaultTag (epic-compaction-tool): ":latest" resolution that ignores registry ports. */
import { describe, it, expect } from "vitest";
import { withDefaultTag } from "@/shared/model-name";

describe("withDefaultTag", () => {
  it.each([
    ["llama3", "llama3:latest"],
    ["llama3:8b", "llama3:8b"],
    ["team/model", "team/model:latest"],
    ["localhost:5000/team/model", "localhost:5000/team/model:latest"],
    ["localhost:5000/team/model:q4", "localhost:5000/team/model:q4"],
  ])("%s -> %s", (name, expected) => {
    expect(withDefaultTag(name)).toBe(expected);
  });
});
