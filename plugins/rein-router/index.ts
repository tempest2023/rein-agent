import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createRouter, assertRuntimeConfig, bindRouterLifecycle, PROVIDER_ID } from './runtime.mjs';
import { validateRouterConfig } from './policy.mjs';
import { createManagedGateway } from './managed-gateway.mjs';
import { bindManagedService, managedServiceScope, managedServiceRegistry } from './service-bridge.mjs';

export default definePluginEntry({
  id: 'rein-router', name: 'Rein Subscription Router',
  description: 'Opt-in Magpie subscription routes and bounded Jev decisions.',
  register(api) {
    const config = validateRouterConfig(api.pluginConfig);
    const gateway = config.enabled && config.gateway.managed ? bindManagedService({
      registry: managedServiceRegistry(),
      scope: managedServiceScope({ source: api.runtimeSource ?? api.source,
        stateDir: api.runtime.state.resolveStateDir(), config }),
      manager: createManagedGateway({ gateway: config.gateway, routes: config.routes,
        allowPaidUsage: config.allowPaidUsage }),
    }) : undefined;
    const router = createRouter({ config, decisions: api.runtime.decisions, gatewayReady: gateway?.isReady });
    if (!router.config.enabled) return;
    assertRuntimeConfig(router.config, api.config);
    bindRouterLifecycle(router, { events: api.runtime.events, lifecycle: api.lifecycle });
    if (gateway) {
      api.registerService({ id: 'rein-magpie', start: gateway.start, stop: gateway.stop });
      if (api.lifecycle.onDispose) api.lifecycle.onDispose(gateway.stop);
      else api.lifecycle.registerRuntimeLifecycle({ id: 'rein-magpie-owner', dispose: gateway.stop });
    }
    api.registerProvider({ id: PROVIDER_ID, label: 'Magpie subscriptions', auth: [],
      envVars: [router.config.gateway.apiKeyEnvVar], wrapStreamFn: router.wrapStreamFn,
      wrapSimpleCompletionStreamFn: router.wrapStreamFn });
    api.on('before_model_resolve', router.beforeModelResolve,
      { priority: 100, timeoutMs: router.config.decision.timeoutMs + 1000 });
    api.on('before_agent_run', router.beforeAgentRun, { priority: 100 });
    api.on('llm_output', router.llmOutput);
    api.registerTool({ contextVersion: 2, create(ctx) {
      return { name: 'rein_route_status', label: 'Subscription route status',
        description: 'Read this session’s declared route and observed provider, model and effort. Billing labels require gateway/provider evidence.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          ctx.assertInvocationCurrent();
          const details = router.status(ctx, { sessionOnly: true });
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        } };
    } }, { names: ['rein_route_status'], optional: true });
  },
});
