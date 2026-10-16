import { run, upstream, requireSource, root, environment } from './runtime-env.mjs';
import { loadMagpieGatewayEnvironment } from './magpie-gateway-env.mjs';
requireSource();
run('pnpm', ['openclaw', ...process.argv.slice(2)], upstream,
  loadMagpieGatewayEnvironment({ root, environment: environment() }));
