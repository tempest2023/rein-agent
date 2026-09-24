import { run, upstream, requireSource } from './runtime-env.mjs';
requireSource();
run('pnpm', ['openclaw', ...process.argv.slice(2)], upstream);
