import { createMessageSender } from './sending';
import { handleUnipileWebhook } from './replies';
import { cleanupExpiredContacts, RETENTION_CRON } from './retention';
import { consoleApi } from './console-api';
import { dashboard, css, script } from './dashboard';

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) {
      const response = await consoleApi(request, env);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      return response;
    }
    if (request.method === 'GET' && ['/', '/console.css', '/console.js'].includes(path)) {
      return new Response(path === '/' ? dashboard : path === '/console.css' ? css : script, {headers:{
        'Content-Type': path === '/' ? 'text/html; charset=utf-8' : path === '/console.css' ? 'text/css' : 'text/javascript',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      }});
    }
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
      if (env.SETTER_MODE === 'draft') return; // Console rollout never invokes the legacy invitation sender.
      const result = await createMessageSender(env)();
      console.log('sendQueuedMessages', result);
    } else {
      throw new Error('Unrecognized cron schedule');
    }
  },
} satisfies ExportedHandler<Env>;
