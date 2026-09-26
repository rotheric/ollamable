import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const backlog = readJson("BACKLOG.json");
const errors = [];
const statuses = { planning: "PLANNED", in_progress: "IN_PROGRESS", done: "DONE", escalated: "ESCALATED" };
for (const entry of readdirSync(resolve(root, "specs"), { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("epic-")) continue;
  const path = `specs/${entry.name}/`;
  const state = readJson(`${path}epic-state.json`);
  const { stories } = readJson(`${path}stories.json`);
  const ids = stories.map((story) => story.id);
  if (ids.length !== new Set(ids).size) errors.push(`${path}: duplicate story IDs`);
  const completed = stories.filter((story) => story.status === "done").map((story) => story.id).sort();
  if (JSON.stringify([...(state.completed_stories ?? [])].sort()) !== JSON.stringify(completed)) {
    errors.push(`${path}: completed_stories disagrees with story statuses`);
  }
  if (state.status === "done" && completed.length !== stories.length) errors.push(`${path}: done epic has unfinished stories`);
  if ((state.phase === "COMPLETE") !== (state.status === "done")) errors.push(`${path}: phase/status completion mismatch`);
  const registered = backlog.epics.find((epic) => epic.path === path);
  if (!registered || registered.status !== statuses[state.status]) errors.push(`${path}: backlog epic status disagrees with state`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Project records agree: backlog, epic states and completed story lists.");
}
