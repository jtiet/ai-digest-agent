// Custom agent tools. Each `tool()` pairs a zod input schema with a handler;
// the schema + description are what the model reads when deciding to call it.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EdgeTTS } from "edge-tts-universal";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordCovered } from "./memory.js";
import { withRetry } from "./retry.js";
import { sendAudio } from "./telegram.js";

const OUT_DIR = fileURLToPath(new URL("../out", import.meta.url));
const DEFAULT_VOICE = "en-US-AndrewNeural";

/** Synthesize text to an MP3 in out/; returns the absolute file path. */
export async function synthesize(
  text: string,
  voice: string = DEFAULT_VOICE,
  fileName: string = `digest-${new Date().toISOString().slice(0, 10)}.mp3`,
): Promise<string> {
  // The Edge Read Aloud endpoint is unofficial and occasionally flaky —
  // synthesis is idempotent, so retry transient failures.
  const { audio } = await withRetry("TTS synthesis", () => new EdgeTTS(text, voice).synthesize());
  mkdirSync(OUT_DIR, { recursive: true });
  const filePath = join(OUT_DIR, fileName);
  writeFileSync(filePath, Buffer.from(await audio.arrayBuffer()));
  return filePath;
}

const synthesizeSpeech = tool(
  "synthesize_speech",
  "Convert a finished spoken-word script into an MP3 audio file with a natural neural voice. " +
    "Returns the absolute path of the generated file. Call this exactly once, after the script is final.",
  {
    text: z
      .string()
      .describe("The full spoken script. Plain prose only — no URLs, markdown, or bullet symbols."),
    voice: z
      .string()
      .optional()
      .describe(`Neural voice name. Defaults to ${DEFAULT_VOICE}.`),
  },
  async ({ text, voice }) => {
    const filePath = await synthesize(text, voice ?? DEFAULT_VOICE);
    return { content: [{ type: "text", text: `Audio written to ${filePath}` }] };
  },
);

const sendTelegramVoice = tool(
  "send_telegram_voice",
  "Deliver a generated MP3 to Jason's Telegram chat as a playable audio message. " +
    "Call this after synthesize_speech, passing the exact file path it returned.",
  {
    filePath: z
      .string()
      .describe("Absolute path to the MP3, as returned by synthesize_speech."),
    caption: z
      .string()
      .optional()
      .describe("One-line caption under the audio, e.g. 'AI Digest — Monday, July 6'."),
  },
  async ({ filePath, caption }) => {
    await sendAudio(filePath, caption);
    return { content: [{ type: "text", text: "Voice digest delivered to Telegram." }] };
  },
);

const recordCoveredTool = tool(
  "record_covered",
  "Save today's covered story headlines into the rolling dedup memory. " +
    "Call this exactly once, after the digest is delivered, with one short headline per story you covered.",
  {
    headlines: z
      .array(z.string().min(1))
      .min(1)
      .describe("One short headline per story in today's digest."),
  },
  async ({ headlines }) => {
    const map = recordCovered(headlines);
    const total = Object.values(map).reduce((n, list) => n + list.length, 0);
    return {
      content: [
        {
          type: "text",
          text: `Memory updated: ${headlines.length} headlines recorded for today (${total} on record across ${Object.keys(map).length} days).`,
        },
      ],
    };
  },
);

/** In-process MCP server exposing the digest tools to the agent loop. */
export const digestServer = createSdkMcpServer({
  name: "digest",
  version: "1.0.0",
  tools: [synthesizeSpeech, sendTelegramVoice, recordCoveredTool],
});

// Standalone test: `npm run test:tts` — synthesizes a fixed sentence and plays it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sentence =
    "This is a test of the voice digest agent. If you can hear this sentence, text to speech is working.";
  synthesize(sentence, DEFAULT_VOICE, "tts-test.mp3")
    .then(async (filePath) => {
      console.log(`Wrote ${filePath}`);
      const { execFile } = await import("node:child_process");
      execFile("afplay", [filePath], (err) => {
        if (err) console.log("(Auto-play failed — open the file manually to listen.)");
      });
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
