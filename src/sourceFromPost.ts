import { env } from 'cloudflare:workers';
import { createPostSource, type SourceResult } from './sourcing';

/** Call from an awaited Worker handler; configuration comes from Worker bindings. */
export async function sourceFromPost(postUrl: string): Promise<SourceResult> {
  return createPostSource(env)(postUrl);
}
