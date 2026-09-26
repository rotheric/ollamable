import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../../server/environment.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "llm-env-"));
  directories.push(root);
  return root;
}

describe("backend environment loading", () => {
  it("parses quoted values, comments, whitespace exports, and embedded equals signs", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), `
      # comment
      QUOTED="example value"
      SINGLE='single # literal'
        export URL="https://example.test/?key=a=b" # ignored comment
      PLAIN=word # another comment
    `);
    const env = {};
    loadEnvironment(root, env);
    expect(env).toEqual({ QUOTED: "example value", SINGLE: "single # literal", URL: "https://example.test/?key=a=b", PLAIN: "word" });
  });

  it("preserves process values including empty strings and gives .env precedence over .envrc", () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "EXISTING=file\nEMPTY=replaced\nPRIORITY=env");
    writeFileSync(join(root, ".envrc"), "export PRIORITY=envrc\nexport SECONDARY='secondary value'");
    const env = { EXISTING: "process", EMPTY: "" };
    loadEnvironment(root, env);
    expect(env).toEqual({ EXISTING: "process", EMPTY: "", PRIORITY: "env", SECONDARY: "secondary value" });
  });

  it("never executes substitutions or expands variable references", () => {
    const root = fixture();
    writeFileSync(join(root, ".envrc"), 'VALUE="$(echo not-executed)"\nREFERENCE="${VALUE}"');
    const env = {};
    loadEnvironment(root, env);
    expect(env).toEqual({ VALUE: "$(echo not-executed)", REFERENCE: "${VALUE}" });
  });

  it("tolerates absent environment files", () => {
    const env = { EXISTING: "unchanged" };
    loadEnvironment(fixture(), env);
    expect(env).toEqual({ EXISTING: "unchanged" });
  });
});
