// Entry point: assembles the prompt, tools, and options, then drives the
// Agent SDK loop while streaming its progress to the terminal.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveredSummary, loadCovered, todayKey } from "./memory.js";
import { sendMessage } from "./telegram.js";
import { digestServer } from "./tools.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The SDK's bundled runtime is a Bun binary that requires AVX CPU
// instructions this Mac doesn't have (it hangs at 100% CPU). Prefer the
// system-installed Claude Code CLI; CLAUDE_EXECUTABLE overrides the location,
// and if neither exists the SDK falls back to its bundled runtime.
const CLAUDE_EXECUTABLE = process.env.CLAUDE_EXECUTABLE ?? join(homedir(), ".local/bin/claude");

// A crashed run can leave the lock behind; locks older than this are stale.
const LOCK_FILE = join(PROJECT_ROOT, "memory", ".lock");
const LOCK_STALE_MS = 30 * 60 * 1000;
const AUDIO_KEEP_DAYS = 14;

const today = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

// Memory is read in code and injected here, and written back through the
// record_covered tool — the agent never touches covered.json directly.
const covered = coveredSummary(loadCovered())
  .split("\n")
  .map((line) => `   ${line}`)
  .join("\n");

const prompt = `
You produce a spoken AI-news digest for Jason, a fullstack software engineer.
Today is ${today}. The deliverable is a voice message in his Telegram, created
with the digest tools available to you. Work through these steps:

1. MEMORY: these stories were covered in the last 3 days — treat stories
   substantially matching them as already told, even if the wording differs:
${covered}

2. RESEARCH: web-search AI news from the last 24 hours in four areas:
   (a) industry & product news; (b) research & papers; (c) developer tools &
   open source; (d) policy & society. Verify stories are actually fresh —
   search results often resurface older popular articles.

3. SELECT: the 5-8 most significant NEW stories. Skip minor funding rounds,
   opinion pieces, rumors, and anything in memory (unless there is a major new
   development — then cover only what is new, framed as an update). Fewer
   stories beats padding.
   FINAL DEDUP PASS: before writing the script, go through your selection
   story by story against the memory list above and state a verdict for each
   (new / repeat / update); drop any match you missed. A story counts as
   covered even if today's articles frame it as a fresh launch or announcement
   of the same thing.

4. SCRIPT: write a ~500-word spoken-word script (about 4 minutes of audio):
   - Open: "Good morning Jason, here's your AI digest for ${today}."
   - A one-breath preview of the top three stories.
   - Each story in 2-4 conversational sentences: what happened, why it matters.
   - One-line sign-off.
   Plain spoken prose only — it will be HEARD, not read: no URLs, no markdown,
   no bullets, no abbreviations a listener would stumble on.

5. DELIVER: call synthesize_speech with the script, then send_telegram_voice
   with the returned file path and the caption "AI Digest — ${today}".
   Call each delivery tool EXACTLY ONCE — they already retry transient
   failures internally. If a tool still returns an error, do not call it
   again; skip to the final summary and report the failure instead.

6. REMEMBER: call record_covered exactly once, with one headline per story
   you just delivered.

7. Finish with a one-paragraph summary of what you covered and delivered.
`.trim();

/** Prevent overlapping runs (which could double-send or clobber memory). */
function acquireLock(): boolean {
  mkdirSync(join(PROJECT_ROOT, "memory"), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      const mtime = statSync(LOCK_FILE, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (Date.now() - mtime < LOCK_STALE_MS) return false;
      rmSync(LOCK_FILE, { force: true }); // stale — a previous run died
    }
  }
  return false;
}

function releaseLock(): void {
  rmSync(LOCK_FILE, { force: true });
}

/** Keep out/ from growing forever; one digest MP3 lands there per day. */
function pruneOldAudio(): void {
  const outDir = join(PROJECT_ROOT, "out");
  if (!existsSync(outDir)) return;
  const cutoff = Date.now() - AUDIO_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".mp3") && statSync(join(outDir, name)).mtimeMs < cutoff) {
      unlinkSync(join(outDir, name));
    }
  }
}

/** Best-effort Telegram notice so scheduled runs can't fail silently. */
async function notify(text: string): Promise<void> {
  try {
    await sendMessage(text);
  } catch {
    console.error("(Could not deliver the notice to Telegram either.)");
  }
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.error("Another digest run appears to be in progress (memory/.lock) — exiting.");
    process.exitCode = 1;
    return;
  }

  try {
    pruneOldAudio();
    const startedAt = Date.now();

    const run = query({
      prompt,
      options: {
        cwd: PROJECT_ROOT,
        // Pin the model — otherwise runs inherit the Claude Code CLI's
        // default, which may be a pricier tier than this job needs.
        model: "claude-sonnet-5",
        ...(existsSync(CLAUDE_EXECUTABLE) ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE } : {}),
        mcpServers: { digest: digestServer },
        allowedTools: [
          "WebSearch",
          "WebFetch",
          "Read",
          "Write",
          "mcp__digest__synthesize_speech",
          "mcp__digest__send_telegram_voice",
          "mcp__digest__record_covered",
        ],
        maxTurns: 40,
      },
    });

    for await (const message of run) {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            console.log(`▶ session started · model: ${message.model}`);
          }
          break;

        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              console.log(`\n💬 ${block.text.trim()}`);
            } else if (block.type === "tool_use") {
              console.log(`  ⚙ ${block.name}`);
            }
          }
          break;

        case "result": {
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
          if (message.subtype === "success") {
            console.log(`\n✅ done in ${seconds}s · ${message.num_turns} turns · $${message.total_cost_usd.toFixed(4)}`);
            if (!(todayKey() in loadCovered())) {
              console.warn("⚠ memory has no entry for today — record_covered was never called.");
              await notify("⚠️ AI digest: delivered, but dedup memory was not updated — tomorrow may repeat stories.");
            }
          } else {
            console.error(`\n❌ ${message.subtype} after ${seconds}s`);
            await notify(`⚠️ AI digest run failed (${message.subtype}) after ${seconds}s — no digest today.`);
            process.exitCode = 1;
          }
          break;
        }
      }
    }
  } finally {
    releaseLock();
  }
}

main().catch(async (err) => {
  console.error(err);
  await notify(`⚠️ AI digest run crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
