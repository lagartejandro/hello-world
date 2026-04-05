import { handler } from './index';

handler().catch(err => {
  console.error('Poller failed:', err);
  process.exit(1);
});
