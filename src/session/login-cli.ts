import { getConfig } from '../config.js';
import { FileSessionStore } from './store.js';
import { CookieJar } from '../linkedin/http/cookie-jar.js';
import { LinkedinHttpClient } from '../linkedin/http/client.js';
import { login, submitChallenge } from '../linkedin/http/login.js';
import { createInterface } from 'node:readline/promises';
import { mkdir } from 'node:fs/promises';

/**
 * Establishes a session from the command line, over plain HTTP.
 *
 *   npm run login
 *
 * The service does this for itself on first use; this exists for two cases the
 * service cannot cover on its own:
 *
 *   - establishing the session from a network LinkedIn already trusts, then
 *     uploading it, which avoids the verification challenge a first sign-in
 *     from a datacenter address usually triggers;
 *   - answering a challenge interactively, at a prompt.
 *
 * No browser is involved. Credentials are read from the environment, sent only
 * to LinkedIn's own sign-in form, and never written to disk.
 */
async function main(): Promise<void> {
  const config = getConfig();

  if (!config.loginEmail || !config.loginPassword) {
    throw new Error('LI_EMAIL and LI_PASSWORD must be set in .env to sign in.');
  }

  const identityId = config.identityLabel.replace(/[^a-zA-Z0-9._-]/g, '_');
  await mkdir(config.sessionStateDir, { recursive: true });
  const store = new FileSessionStore(config.sessionStateDir);

  const jar = new CookieJar();
  const client = new LinkedinHttpClient(jar);

  try {
    const outcome = await login(
      client,
      { email: config.loginEmail, password: config.loginPassword },
      (message) => console.log(`→ ${message}`),
    );

    if (outcome.status === 'challenge') {
      console.log('');
      console.log('LinkedIn issued a verification challenge.');
      console.log(`  ${outcome.challengeUrl}`);
      console.log('A code has been emailed to the account.');
      console.log('');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const code = (await rl.question('Verification code: ')).trim();
      rl.close();

      await submitChallenge(
        client,
        { challengeUrl: outcome.challengeUrl!, challengeFields: outcome.challengeFields ?? {} },
        code,
        (message) => console.log(`→ ${message}`),
      );
    }

    if (!jar.isAuthenticated()) {
      throw new Error('Sign-in finished without producing a session.');
    }

    // Confirm against the API rather than trusting the cookie's presence.
    const me = await client.request({ path: '/voyager/api/me', kind: 'api' });
    if (me.status !== 200) {
      throw new Error(`Session was created but /voyager/api/me returned ${me.status}.`);
    }
    const firstName = /"firstName":"([^"]*)"/.exec(me.body)?.[1] ?? '(unknown)';

    await store.save(identityId, jar.toJSON() as never);

    console.log('');
    console.log(`✓ signed in as ${firstName}`);
    console.log(`✓ session saved for identity "${config.identityLabel}" → ${config.sessionStateDir}/${identityId}.json`);
    console.log('');
    console.log('  That file is a live session. It is gitignored and written mode 0600.');
    console.log('  LI_PASSWORD can now be removed from .env; it is only read when no session exists.');
  } finally {
    await client.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('');
    console.error('✗ sign-in failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
