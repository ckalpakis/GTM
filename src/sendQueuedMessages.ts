import { env } from 'cloudflare:workers';
import { createMessageSender, type SendSummary } from './sending';

export async function sendQueuedMessages(): Promise<SendSummary> {
  return createMessageSender(env)();
}
