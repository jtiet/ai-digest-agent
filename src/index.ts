// Entry point: assembles the prompt, tools, and options, then drives the
// Agent SDK loop while streaming its progress to the terminal.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
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

const prompt = `
You produce a spoken AI-news digest for Jason, a fullstack software engineer.
Today is ${today}. The deliverable is a voice message in his Telegram, created
with the digest tools available to you. Work through these steps:

1. MEMORY: read memory/covered.json if it exists — it maps dates to headlines
   already covered. Treat stories substantially matching those headlines as
   already told, even if the wording differs.

2. RESEARCH: web-search AI news from the last 24 hours in four areas:
   (a) industry & product news; (b) research & papers; (c) developer tools &
   open source; (d) policy & society. Verify stories are actually fresh —
   search results often resurface older popular articles.

3. SELECT: the 5-8 most significant NEW stories. Skip minor funding rounds,
   opinion pieces, rumors, and anything in memory (unless there is a major new
   development — then cover only what is new). Fewer stories beats padding.

4. SCRIPT: write a ~500-word spoken-word script (about 4 minutes of audio):
   - Open: "Good morning Jason, here's your AI digest for ${today}."
   - A one-breath preview of the top three stories.
   - Each story in 2-4 conversational sentences: what happened, why it matters.
   - One-line sign-off.
   Plain spoken prose only — it will be HEARD, not read: no URLs, no markdown,
   no bullets, no abbreviations a listener would stumble on.

5. DELIVER: call synthesize_speech with the script, then send_telegram_voice
   with the returned file path and the caption "AI Digest — ${today}".

6. REMEMBER: write memory/covered.json with today's headlines added and any
   entries older than 3 days removed. Format:
   { "YYYY-MM-DD": ["headline", ...], ... }

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
