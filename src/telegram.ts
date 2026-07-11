// Telegram Bot API helpers. No SDK — the Bot API is a plain HTTPS API,
// and Node 18+ ships fetch/FormData/Blob natively.
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { withRetry } from "./retry.js";

// Minimal .env loader: two variables don't justify a dependency.
// Real values never take precedence over an already-set environment.
const envPath = new URL("../.env", import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — is .env present?`);
  return value;
}

const apiBase = () => `https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}`;
const chatId = () => requireEnv("TELEGRAM_CHAT_ID");

class TelegramError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

async function callApi(method: string, body: FormData | URLSearchParams): Promise<unknown> {
  const res = await fetch(`${apiBase()}/${method}`, { method: "POST", body });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    // 4xx means the request itself is wrong — a retry can't fix it.
    const retryable = res.status >= 500 || res.status === 429;
    throw new TelegramError(`Telegram ${method} failed: ${json.description ?? res.status}`, retryable);
  }
  return json.result;
}

// Sends are not idempotent, so retry at most once, and only for failures
// where the message clearly did not go through (network error, 429, 5xx).
function sendWithRetry(method: string, body: FormData | URLSearchParams): Promise<unknown> {
  return withRetry(`Telegram ${method}`, () => callApi(method, body), {
    attempts: 2,
    shouldRetry: (err) => !(err instanceof TelegramError) || err.retryable,
  });
}

/** Send a plain text message to the digest chat. */
export async function sendMessage(text: string): Promise<void> {
  const params = new URLSearchParams({
    chat_id: chatId(),
    text,
    // JSON-valued parameters are sent as serialized strings in form encoding
    link_preview_options: JSON.stringify({ is_disabled: true }),
  });
  await sendWithRetry("sendMessage", params);
}

/** Send an audio file (MP3) to the digest chat; plays inline in Telegram. */
export async function sendAudio(filePath: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId());
  form.append("audio", new Blob([readFileSync(filePath)], { type: "audio/mpeg" }), basename(filePath));
  form.append("title", "AI Digest");
  if (caption) form.append("caption", caption);
  await sendWithRetry("sendAudio", form);
}

// Standalone test: `npm run test:telegram`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  sendMessage("👋 Hello from the SDK agent project — telegram.ts works.")
    .then(() => console.log("Sent. Check your phone."))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
