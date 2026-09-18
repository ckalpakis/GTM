import { createMessageSender } from './sending';
import { handleUnipileWebhook } from './replies';
import { cleanupExpiredContacts, RETENTION_CRON } from './retention';

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/webhooks/unipile') {
      return handleUnipileWebhook(request, env);
    }
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      try {
        // Check that the application schema, not just the binding, is ready.
        await env.DB.prepare('SELECT id FROM contacts LIMIT 1').first();
        return Response.json({ status: 'ok' });
      } catch {
        return Response.json({ status: 'unavailable' }, { status: 503 });
      }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env): Promise<void> {
    if (event.cron === RETENTION_CRON) {
      const result = await cleanupExpiredContacts(env);
      console.log('cleanupExpiredContacts', result);
      if (result.hasMore) console.warn('Retention cleanup reached its batch limit; expired contacts remain');
    } else if (event.cron === '*/15 * * * *') {
      const result = await createMessageSender(env)();
      console.log('sendQueuedMessages', result);
    } else {
      throw new Error('Unrecognized cron schedule');
    }
  },
} satisfies ExportedHandler<Env>;
