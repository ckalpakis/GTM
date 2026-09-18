import { env } from 'cloudflare:workers';
import { createMessageDrafter } from './drafting';
import type { DraftContact, Message } from './db';

/** Generate and save an unchecked connection note; never queue or send it. */
export async function draftMessage(contact: DraftContact): Promise<Message> {
  return createMessageDrafter(env)(contact);
}
