import { runLogin } from './login.js';

runLogin()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('');
    console.error('✗ login failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
