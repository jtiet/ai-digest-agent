# ai-digest-agent

An autonomous AI news agent built with the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript) (TypeScript).

On each run, the agent:

1. **Researches** the last 24 hours of AI news across four beats — industry & product, research & papers, developer tools & open source, and policy & society — using live web search.
2. **Selects** the 5–8 most significant stories, skipping anything it already covered in the past 3 days (it keeps a rolling memory file between runs).
3. **Writes** a ~500-word spoken-word script — prose meant to be *heard*, not read.
4. **Synthesizes** the script into audio using Microsoft's neural voices (via [edge-tts-universal](https://www.npmjs.com/package/edge-tts-universal) — free, no API key).
5. **Delivers** the result as a ~4-minute voice message to a Telegram chat.

The interesting part is *how*: none of those steps are hard-coded as a pipeline. The agent receives a goal-oriented prompt plus a set of tools, and the model plans and executes the run itself — deciding what to search, judging which stories matter, checking its own word count, and calling the custom tools in the right order. The terminal output streams its reasoning live.

## Architecture

```
src/index.ts     entry point: prompt + query() agent loop, streams progress
src/tools.ts     custom MCP tools: synthesize_speech, send_telegram_voice
src/telegram.ts  Telegram Bot API helpers (plain fetch, no SDK)
src/smoke.ts     minimal SDK round-trip (auth/runtime diagnostic)
memory/          rolling covered.json for story dedup (gitignored)
out/             generated scripts and audio (gitignored)
```

The custom tools are defined with `createSdkMcpServer()` + `tool()` from the
Agent SDK: a zod schema describes each tool's inputs to the model, and a plain
TypeScript handler executes locally when the model calls it. Text-to-speech is
a thin client over Microsoft Edge's Read Aloud service; Telegram delivery is a
multipart upload to the Bot API — no file hosting required.

## Prerequisites

- **Node.js 18+**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in on the machine — the agent authenticates through it (no `ANTHROPIC_API_KEY` needed; runs draw on your Claude subscription)
- **A Telegram bot**: message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, and copy the token. Then open your new bot's chat and send it any message.
- **Your chat ID**: with the bot messaged once, run
  `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and read
  `result[0].message.chat.id` from the response.

## Setup

```bash
git clone https://github.com/jtiet/ai-digest-agent.git
cd ai-digest-agent
npm install
```

Create a `.env` file in the project root (it is gitignored — never commit it):

```
TELEGRAM_BOT_TOKEN=<token from @BotFather>
TELEGRAM_CHAT_ID=<your chat id>
```

Verify the two halves of the delivery pipeline independently:

```bash
npm run test:telegram   # sends a hello text to your chat
npm run test:tts        # synthesizes a test sentence and plays it
```

## Running

```bash
npm run digest
```

Expect a few minutes of live progress in the terminal — tool calls (⚙) and the
agent's own narration (💬) — ending with a summary like:

```
▶ session started · model: claude-sonnet-5
  ⚙ WebSearch
💬 473 words — right in the target range. Now let's deliver via the digest tools.
  ⚙ mcp__digest__synthesize_speech
  ⚙ mcp__digest__send_telegram_voice
✅ done in 216s · 23 turns · $0.7359
```

…and a voice message in your Telegram chat.

Run it on demand, or schedule it (cron / launchd) if you want a daily edition —
each run costs roughly $0.30–0.75 of usage depending on the news day.

## Configuration

- **Voice**: default is `en-US-AndrewNeural`; change `DEFAULT_VOICE` in
  `src/tools.ts` (any Edge neural voice name works).
- **Length / tone / categories**: all live in the prompt in `src/index.ts` —
  the prompt is the program.
- **Memory window**: the dedup horizon (3 days) is also prompt-defined.

## Troubleshooting

- **Agent hangs at startup, 100% CPU:** the SDK's bundled runtime is a Bun
  binary that requires AVX CPU instructions. On CPUs without AVX, point the SDK
  at your installed Claude Code CLI instead — this project already does, via
  `pathToClaudeCodeExecutable` in `src/index.ts` (adjust the path if your CLI
  lives elsewhere). `npx tsx src/smoke.ts` is the quick way to test the
  runtime and auth in isolation.
- **`Telegram sendMessage failed`:** check the `.env` values, and make sure
  you've sent your bot at least one message (bots can't initiate chats).
- **TTS fails:** edge-tts wraps an unofficial Microsoft endpoint that
  occasionally changes; update `edge-tts-universal` or swap in an alternative
  client package.
