import { isRetryableStatus } from '../../../lib/backoff';
import { renderText, type ChannelSender, type SendInput, type SendResult } from './types';

interface TelegramReply {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Telegram Bot API: POST /bot<token>/sendMessage { chat_id, text }.
 * - 429 "Too Many Requests" includes parameters.retry_after: we wait at least that long
 * - 400 "chat not found" / 403 "bot was blocked by the user": permanent, retrying won't help
 * The token is part of the URL, so error messages never include the URL.
 */
export function createTelegramSender(
  token: string | undefined,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): ChannelSender {
  return {
    type: 'telegram',
    async send({ delivery: d }: SendInput): Promise<SendResult> {
      const started = Date.now();
      const durationMs = () => Date.now() - started;
      if (!token) {
        return {
          ok: false,
          retryable: false,
          error: 'Telegram is not configured on this server',
          durationMs: 0,
        };
      }
      let res: Response;
      try {
        res = await fetchImpl(`${apiUrl}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(d.c_config.chatId),
            text: renderText(d).slice(0, 4096), // Telegram's message limit
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          error: `Telegram unreachable: ${(err as Error).name}`,
          durationMs: durationMs(),
        };
      }
      const reply = (await res.json().catch(() => ({ ok: false }))) as TelegramReply;
      if (res.ok && reply.ok) return { ok: true, httpStatus: res.status, durationMs: durationMs() };
      return {
        ok: false,
        retryable: isRetryableStatus(res.status),
        httpStatus: res.status,
        error: `Telegram ${res.status}: ${reply.description ?? 'unknown error'}`,
        retryAfterSec: reply.parameters?.retry_after,
        durationMs: durationMs(),
      };
    },
  };
}
