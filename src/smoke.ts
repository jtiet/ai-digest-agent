import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
const run = query({
  prompt: "Reply with exactly: OK",
  options: { maxTurns: 1, pathToClaudeCodeExecutable: join(homedir(), ".local/bin/claude") },
});
for await (const m of run) {
  if (m.type === "system" && (m as any).subtype === "init") console.log("INIT ok, model:", (m as any).model);
  if (m.type === "result") { console.log("RESULT:", (m as any).subtype); process.exit(0); }
}
