// Rolling dedup memory: memory/covered.json maps YYYY-MM-DD to headlines
// already covered. Loading, validating, pruning, and writing all happen here
// in code — the agent only supplies headlines via the record_covered tool —
// so a wandering run can't corrupt the file or forget to prune it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// DIGEST_MEMORY_DIR overrides the location so tests can use a temp dir.
const memoryDir = () => process.env.DIGEST_MEMORY_DIR ?? fileURLToPath(new URL("../memory", import.meta.url));
const memoryFile = () => join(memoryDir(), "covered.json");
const HORIZON_DAYS = 3;

export type CoveredMap = Record<string, string[]>;

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Load the covered map, dropping malformed entries and expired dates.
 *  A missing or unparseable file yields an empty map rather than a crash. */
export function loadCovered(): CoveredMap {
  if (!existsSync(memoryFile())) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(memoryFile(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a date → headlines object");
    }
    const map: CoveredMap = {};
    for (const [date, headlines] of Object.entries(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray(headlines)) {
        map[date] = headlines.filter((h): h is string => typeof h === "string");
      }
    }
    return pruneOld(map);
  } catch (err) {
    // Keep the bad file for inspection and start fresh.
    renameSync(memoryFile(), `${memoryFile()}.corrupt`);
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`memory/covered.json was unreadable (${reason}); moved to covered.json.corrupt`);
    return {};
  }
}

function pruneOld(map: CoveredMap): CoveredMap {
  const cutoff = new Date(Date.now() - HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(map).filter(([date]) => date >= cutoff));
}

/** Merge today's headlines into the map and persist it atomically. */
export function recordCovered(headlines: string[]): CoveredMap {
  const map = loadCovered();
  map[todayKey()] = [...new Set([...(map[todayKey()] ?? []), ...headlines])];
  mkdirSync(memoryDir(), { recursive: true });
  const tmp = `${memoryFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
  renameSync(tmp, memoryFile());
  return map;
}

/** Format the covered map for inclusion in the agent prompt. */
export function coveredSummary(map: CoveredMap): string {
  const dates = Object.keys(map).sort().reverse();
  if (dates.length === 0) return "(no stories on record — first run or fresh memory)";
  return dates.map((date) => `${date}:\n${map[date].map((h) => `  - ${h}`).join("\n")}`).join("\n");
}
