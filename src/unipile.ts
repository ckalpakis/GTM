export interface UnipileEnvironment {
  UNIPILE_DSN?: string;
  UNIPILE_API_KEY?: string;
  UNIPILE_ACCOUNT_ID?: string;
}

export class UnipileError extends Error {
  constructor(public readonly code: string, public readonly uncertain: boolean) {
    super(`Unipile ${code}`);
  }
}

export function unipileConfig(env: UnipileEnvironment) {
  if (!env.UNIPILE_DSN || !env.UNIPILE_API_KEY?.trim() || !env.UNIPILE_ACCOUNT_ID?.trim()) {
    throw new Error('UNIPILE_DSN, UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID are required');
  }
  const base = new URL(env.UNIPILE_DSN);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.unipile.com') ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('UNIPILE_DSN must be your HTTPS Unipile origin, including its port if supplied');
  }
  return { origin: base.origin, apiKey: env.UNIPILE_API_KEY.trim(), accountId: env.UNIPILE_ACCOUNT_ID.trim() };
}

export function createUnipileClient(env: UnipileEnvironment, fetcher: typeof fetch = fetch) {
  const config = unipileConfig(env);
  async function request(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetcher(`${config.origin}/api/v1${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-API-KEY': config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UnipileError(`http_${response.status}`, response.status >= 500 || response.status === 408);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new UnipileError('invalid_response', true);
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UnipileError) throw error;
      // Timeouts/network failures can happen after provider acceptance. Never auto-retry POST.
      throw new UnipileError(controller.signal.aborted ? 'timeout' : 'request_failed', true);
    } finally { clearTimeout(timer); }
  }
  return {
    accountId: config.accountId,
    async resolveProfile(linkedinUrl: string): Promise<string> {
      const identifier = decodeURIComponent(new URL(linkedinUrl).pathname.split('/')[2] ?? '');
      if (!identifier) throw new UnipileError('missing_identifier', false);
      const profile = await request(`/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(config.accountId)}&notify=false`);
      if (typeof profile.provider_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(profile.provider_id)) {
        throw new UnipileError('invalid_profile', false);
      }
      return profile.provider_id;
    },
    async invite(providerId: string, message: string): Promise<void> {
      const response = await request('/users/invite', { account_id: config.accountId, provider_id: providerId, message });
      if (response.object !== 'UserInvitationSent' || typeof response.invitation_id !== 'string' || !response.invitation_id) {
        throw new UnipileError('unconfirmed_invitation', true);
      }
    },
  };
}
