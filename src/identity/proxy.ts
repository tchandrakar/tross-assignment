import { ProxyAgent, Agent, type Dispatcher } from 'undici';

/**
 * Proxy plumbing. Deliberately provider-agnostic: everything is expressed as a
 * standard `http://user:pass@host:port` URL, which is the lowest common
 * denominator across Webshare / IPRoyal / Decodo / Bright Data / self-hosted.
 */

/**
 * Providers that support sticky sessions encode a session id in the proxy
 * username. The template lets us stay provider-agnostic while still pinning an
 * identity to a single egress IP:
 *
 *   http://user-session-{session}:pass@gate.provider.com:7000
 *
 * Why pin at all? A LinkedIn session cookie that hops IPs on every request
 * looks exactly like a stolen cookie being replayed, and trips the security
 * checkpoint. One identity ⇒ one IP is the whole point.
 */
export function renderStickyProxy(template: string, sessionId: string): string {
  return template.replaceAll('{session}', sessionId);
}

const agentCache = new Map<string, Dispatcher>();

/** Direct (no proxy) dispatcher, shared across all unproxied identities. */
const directAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 16,
});

export function getDispatcher(proxyUrl: string | undefined): Dispatcher {
  if (!proxyUrl) return directAgent;

  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxyUrl,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 8,
    });
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

export async function closeDispatchers(): Promise<void> {
  await Promise.allSettled([...agentCache.values()].map((a) => a.close()));
  agentCache.clear();
  await directAgent.close().catch(() => undefined);
}

/** Strips credentials so proxy URLs can be logged safely. */
export function redactProxy(proxyUrl: string | undefined): string {
  if (!proxyUrl) return 'direct';
  try {
    const u = new URL(proxyUrl);
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}`;
  } catch {
    return 'invalid-proxy-url';
  }
}
