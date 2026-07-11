// Entry point: assembles the prompt, tools, and options, then drives the
// Agent SDK loop while streaming its progress to the terminal.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveredSummary, loadCovered, todayKey } from "./memory.js";
import { digestServer } from "./tools.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The SDK's bundled runtime is a Bun binary that requires AVX CPU
// instructions this Mac doesn't have (it hangs at 100% CPU). Use the
// system-installed Claude Code CLI instead.
const CLAUDE_EXECUTABLE = join(homedir(), ".local/bin/claude");

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

async function main(): Promise<void> {
  const startedAt = Date.now();

  const run = query({
    prompt,
    options: {
      cwd: PROJECT_ROOT,
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
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
          }
        } else {
          console.error(`\n❌ ${message.subtype} after ${seconds}s`);
          process.exitCode = 1;
        }
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
