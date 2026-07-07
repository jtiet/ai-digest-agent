# ai-digest-agent

A local AI agent built on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript).
Each run it researches the last 24 hours of AI news, writes a ~4-minute spoken
script, synthesizes audio with Microsoft's neural voices (edge-tts), and sends
the result as a voice message to a Telegram chat. A rolling 3-day memory file
prevents repeated stories across runs.

## Architecture

```
src/index.ts     entry point: prompt + query() agent loop, streams progress
src/tools.ts     custom MCP tools: synthesize_speech, send_telegram_voice
src/telegram.ts  Telegram Bot API helpers (fetch, no SDK)
memory/          rolling covered.json for story dedup (gitignored)
out/             generated audio (gitignored)
```

## Setup

1. `npm install`
2. Create `.env`:
   ```
   TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
   TELEGRAM_CHAT_ID=<your chat id>
   ```
3. Authenticate Claude Code on the machine (the SDK reuses its login).

## Commands

| Command | Purpose |
|---|---|
| `npm run digest` | Full agent run: research → script → audio → Telegram |
| `npm run test:telegram` | Send a test text message |
| `npm run test:tts` | Synthesize and play a test sentence |
| `npx tsx src/smoke.ts` | Minimal SDK round-trip (auth/runtime check) |

## Note: CPU without AVX

The SDK's bundled runtime is a Bun binary requiring AVX instructions; on CPUs
without AVX it hangs at 100% CPU. This project points the SDK at the
system-installed Claude Code CLI instead (`pathToClaudeCodeExecutable` in
`src/index.ts`).
