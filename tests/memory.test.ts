// Tests for the rolling dedup memory. DIGEST_MEMORY_DIR points every test at
// its own temp dir so the real memory/covered.json is never touched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { coveredSummary, loadCovered, recordCovered, todayKey } from "../src/memory.js";

let dir: string;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "digest-memory-"));
  process.env.DIGEST_MEMORY_DIR = dir;
});

test("loadCovered returns empty map when no file exists", () => {
  assert.deepEqual(loadCovered(), {});
});

test("loadCovered keeps entries within the 3-day horizon and prunes older ones", () => {
  writeFileSync(
    join(dir, "covered.json"),
    JSON.stringify({
      [daysAgo(0)]: ["today"],
      [daysAgo(3)]: ["edge of horizon"],
      [daysAgo(4)]: ["too old"],
    }),
  );
  const map = loadCovered();
  assert.deepEqual(Object.keys(map).sort(), [daysAgo(3), daysAgo(0)].sort());
});

test("loadCovered drops malformed entries but keeps valid ones", () => {
  writeFileSync(
    join(dir, "covered.json"),
    JSON.stringify({
      [daysAgo(1)]: ["valid", 42, null, "also valid"],
      "not-a-date": ["ignored"],
      [daysAgo(2)]: "not-an-array",
    }),
  );
  const map = loadCovered();
  assert.deepEqual(map, { [daysAgo(1)]: ["valid", "also valid"] });
});

test("loadCovered quarantines a corrupt file and starts fresh", () => {
  writeFileSync(join(dir, "covered.json"), "{broken json");
  assert.deepEqual(loadCovered(), {});
  assert.ok(existsSync(join(dir, "covered.json.corrupt")), "corrupt file kept for inspection");
  assert.ok(!existsSync(join(dir, "covered.json")), "bad file moved out of the way");
});

test("recordCovered writes today's key and dedupes within the day", () => {
  recordCovered(["A", "B"]);
  const map = recordCovered(["B", "C"]);
  assert.deepEqual(map[todayKey()], ["A", "B", "C"]);
  // Persisted, not just returned
  const onDisk = JSON.parse(readFileSync(join(dir, "covered.json"), "utf8"));
  assert.deepEqual(onDisk[todayKey()], ["A", "B", "C"]);
});

test("recordCovered prunes expired dates as it writes", () => {
  writeFileSync(join(dir, "covered.json"), JSON.stringify({ [daysAgo(5)]: ["ancient"] }));
  const map = recordCovered(["fresh"]);
  assert.deepEqual(Object.keys(map), [todayKey()]);
});

test("coveredSummary formats newest-first with indented headlines", () => {
  const summary = coveredSummary({ [daysAgo(1)]: ["older"], [daysAgo(0)]: ["newer"] });
  assert.match(summary, new RegExp(`^${daysAgo(0)}:\\n  - newer\\n${daysAgo(1)}:\\n  - older$`));
});

test("coveredSummary explains an empty memory", () => {
  assert.match(coveredSummary({}), /no stories on record/);
});
