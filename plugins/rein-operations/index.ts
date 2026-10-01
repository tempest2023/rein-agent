import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRound, castBallot, tallyRound } from "./governance.ts";
import { checkCompleteness, validateSchedule, routeProcessingPath } from "./proposals.ts";
import { createProposalStore } from "./proposal-store.ts";
import { createProposalToolRegistration, PROPOSAL_TOOL_NAMES } from "./proposal-tool-bridge.ts";
import { createGovernanceReadToolRegistration, GOVERNANCE_READ_TOOL_NAMES } from "./governance-read-tools.ts";
import { createGovernanceWriteToolRegistration, GOVERNANCE_WRITE_TOOL_NAMES } from "./governance-write-tools.ts";
import { createProposalFeedbackToolRegistration, GOVERNANCE_FEEDBACK_TOOL_NAMES } from "./proposal-feedback-tools.ts";
import { createProposalCollectToolRegistration, GOVERNANCE_COLLECT_TOOL_NAMES } from "./proposal-collect-tools.ts";
import { COLLECT_REPLY_GUARD_TOOL_NAMES, createCollectReplyGuard } from "./proposal-collect-reply-guard.ts";
import type { GuardDiagnosticSink } from "./proposal-collect-reply-guard.ts";
import { POLL_REPLY_GUARD_TOOL_NAMES, createPollReplyGuard } from "./poll-reply-guard.ts";
import { VOTE_REPLY_GUARD_TOOL_NAMES, createVoteReplyGuard } from "./vote-reply-guard.ts";
import { createBackendRuntime } from "./backend-runtime.ts";
import { IDENTITY_BIND_TOOL_NAMES, createIdentityToolsRegistration } from "./identity-tools.ts";

// This first tool proves the external-plugin boundary without enabling business actions.
export default definePluginEntry({
  id: "rein-operations",
  name: "Rein Operations",
  description: "Rein Protocol Foundation operations extension",
  register(api) {
    const proposalConfig = api.pluginConfig?.proposalTools;
    const proposalEnabled = Boolean(proposalConfig && typeof proposalConfig === 'object' && (proposalConfig as Record<string, unknown>).enabled === true);
    const foundationDbConfig = api.pluginConfig?.foundationDb;
    const governanceToolsEnabled = Boolean(foundationDbConfig && typeof foundationDbConfig === 'object' && (foundationDbConfig as Record<string, unknown>).enabled === true);
    if (governanceToolsEnabled) {
      // The backend runtime owns the only credential the Agent holds: the Agent credential named by
      // foundationDb.agentCredentialEnvVar, presented as a Bearer token to the backend. The proof the
      // governance and identity tools carry is minted here, per tool call, from the host's own tool
      // context and never from a tool argument. It is minted by relaying the trusted inbound tuple to
      // POST /api/ingress/relay under the enrolled caller, then kept in a private WeakMap keyed by that
      // context, so it reaches the backend call and never a model-visible field or result. An enabled
      // but incomplete block, an unset environment variable, a channel outside the configured
      // workspaces or a missing current-invocation guard fails closed with no backend call.
      const runtime = createBackendRuntime({
        config: foundationDbConfig as Record<string, unknown>,
      });
      if (!runtime) {
        throw new Error('foundationDb is enabled but the backend runtime could not be constructed');
      }
      const proofProvider = runtime.proofProvider;
      // Field collection answers the model with structured detail that names internal vocabulary
      // (the configured vote type code, missing-field names, the sealed draft token). Prompt text
      // alone did not stop that vocabulary reaching the member, so the member-facing boundary is
      // enforced in code: one successful collect is remembered by run, and only that run's final
      // Slack reply is rewritten with plain copy built from the proposer's own words and the tool's
      // own ready-made question lines. A submit observed in that same run drops the remembered
      // collect, so the submit outcome is delivered as the model wrote it rather than rewritten into
      // the collect prompt. This is not a blanket guarantee: only a recognized event shape with a
      // usable run id arms the guard, so a malformed event or a missing run id leaves the payload
      // exactly as the host made it. Every other tool, run, surface, dispatch kind and payload is
      // likewise left untouched, and nothing is ever sent from here.
      // On a live Gateway both tools arrive through Tool Search, which reports the outer dispatcher
      // named `tool_call` rather than the guest tool; the matcher admits that dispatcher too, and the
      // guard reads the real tool identity from the host's own envelope instead of any model-written
      // parameter, so an unrelated `tool_call` is still ignored.
      // The hooks register only where the host exposes them, so an api object that cannot carry a
      // hook still gets every tool and never fails to load because the guard could not attach.
      if (typeof api.on === 'function') {
        // The guard's hook-chain trace is off unless an operator sets its environment variable; when
        // it is on, the lines go to the host's own plugin logger so they land in the gateway log the
        // operator is already reading. A host api without a logger simply gets no diagnostic lines,
        // and the guard still registers exactly as before.
        const hostLogger = (api as { logger?: GuardDiagnosticSink }).logger;
        const collectReplyGuard = createCollectReplyGuard({
          ...(hostLogger ? { diagnostic: hostLogger } : {}),
        });
        api.on('after_tool_call', collectReplyGuard.afterToolCall, { matcher: [...COLLECT_REPLY_GUARD_TOOL_NAMES] });
        api.on('reply_payload_sending', collectReplyGuard.replyPayloadSending);
        // A successful ballot answers with the stored poll identifier, the field names and a reason
        // code, and case 6 only needs the director to hear that the vote was recorded, how many
        // proposals they approved (or that the abstention is recorded) and that the record moves no
        // money. One verified successful ballot whose call is the run's only observed tool call is
        // remembered by run, and only that run's final Slack reply is replaced with wording this
        // guard builds itself. A failed ballot, an error answer or a second tool call in the same run
        // disqualifies the run, so a write outcome, a round result and a multi-step turn are all
        // delivered as the model wrote them. This is a third, separate store, so the collect guard and
        // the poll guard never read this entry and vice versa; it is reached through Tool Search as
        // `tool_call` like the others, and nothing is ever sent from here.
        const voteReplyGuard = createVoteReplyGuard();
        api.on('after_tool_call', voteReplyGuard.afterToolCall, { matcher: [...VOTE_REPLY_GUARD_TOOL_NAMES] });
        api.on('reply_payload_sending', voteReplyGuard.replyPayloadSending);
        // The round result already carries the member-facing wording for case 7 in
        // `narration.note`, and the same prompt-only boundary held no better here than it did for
        // field collection: a validated note is remembered by run, and only that run's final Slack
        // reply is replaced with the tool's own sentence. A write observed in that same run drops the
        // remembered note, so a write outcome is delivered as the model wrote it. This is a separate
        // store from the collect guard's, so the two never read each other's entry, and every other
        // tool, run, surface, dispatch kind and payload is left untouched; nothing is ever sent from
        // here. The two guards are both reached through Tool Search as `tool_call`, so the matcher
        // admits that dispatcher and each guard reads the real tool identity from the host's envelope.
        const pollReplyGuard = createPollReplyGuard();
        api.on('after_tool_call', pollReplyGuard.afterToolCall, { matcher: [...POLL_REPLY_GUARD_TOOL_NAMES] });
        api.on('reply_payload_sending', pollReplyGuard.replyPayloadSending);
      }
      // governance mode exposes the database-backed read and write tools instead of the synthetic
      // simulators and the legacy local-ledger proposal tools. Configuration is validated here so
      // an enabled but incomplete block fails loudly. The Agent holds no database credential: the
      // only secret it carries is the backend Agent credential, read from the server environment
      // named by foundationDb.agentCredentialEnvVar and never stored in plugin config.
      api.registerTool(
        runtime.wrapRegistration(
          createGovernanceReadToolRegistration({
            config: foundationDbConfig as Record<string, unknown>,
            proofProvider,
          }),
        ),
        { names: [...GOVERNANCE_READ_TOOL_NAMES] },
      );
      api.registerTool(
        runtime.wrapRegistration(
          createGovernanceWriteToolRegistration({
            config: foundationDbConfig as Record<string, unknown>,
            proofProvider,
          }),
        ),
        { names: [...GOVERNANCE_WRITE_TOOL_NAMES] },
      );
      // Multi-turn field collection registers with the same explicit block and is read-only: it
      // states which fields a submit still needs and returns a short prompt, but stores nothing and
      // never submits even once every required field is present (case 3, PRD §2.3 step 2).
      api.registerTool(
        runtime.wrapRegistration(
          createProposalCollectToolRegistration({
            config: foundationDbConfig as Record<string, unknown>,
            proofProvider,
          }),
        ),
        { names: [...GOVERNANCE_COLLECT_TOOL_NAMES] },
      );
      // Post-result feedback registers with the same explicit block: a comment or suggested
      // revision, a director's approval of a material revision, and the guarded apply step. The
      // database refuses a material revision until a current director's approval is recorded.
      api.registerTool(
        runtime.wrapRegistration(
          createProposalFeedbackToolRegistration({
            config: foundationDbConfig as Record<string, unknown>,
            proofProvider,
          }),
        ),
        { names: [...GOVERNANCE_FEEDBACK_TOOL_NAMES] },
      );
      // Identity binding is the one surface an unidentified person may still use: starting a bind
      // returns a website URL, and completing it takes only the short code the person carries back.
      // Neither tool accepts an email, contact, user id or any other claimed identity, and the acting
      // account comes only from the host context through the same minted proof.
      api.registerTool(
        runtime.wrapRegistration(createIdentityToolsRegistration({ runtime, proofProvider })),
        { names: [...IDENTITY_BIND_TOOL_NAMES] },
      );
    } else if (proposalEnabled) {
      const configured = proposalConfig as Record<string, unknown>;
      const platform = configured.platform;
      const allowedNativeChannelIds = configured.allowedNativeChannelIds;
      const statePath = configured.statePath;
      if (!['discord', 'slack'].includes(platform) ||
          !Array.isArray(allowedNativeChannelIds) || allowedNativeChannelIds.length === 0 ||
          allowedNativeChannelIds.some(id => typeof id !== 'string' || !id.trim()) ||
          typeof statePath !== 'string' || !isAbsolute(statePath)) {
        throw new Error('rein proposal tools require one platform, nonempty native channel IDs and an absolute statePath');
      }
      const store = createProposalStore({ path: statePath });
      api.registerTool(createProposalToolRegistration({ platform, allowedNativeChannelIds, store }), {
        names: [...PROPOSAL_TOOL_NAMES], optional: true,
      });
    }
    api.registerTool({
      name: "rein_status",
      description: "Report implemented Rein capabilities and pending integrations. Does not query or change live organization records.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const details = {
          stage: "development",
          implemented: governanceToolsEnabled
            ? ["rein_status", ...GOVERNANCE_READ_TOOL_NAMES, ...GOVERNANCE_WRITE_TOOL_NAMES, ...GOVERNANCE_COLLECT_TOOL_NAMES, ...GOVERNANCE_FEEDBACK_TOOL_NAMES, ...IDENTITY_BIND_TOOL_NAMES]
            : ["rein_status", "rein_simulate_vote", "rein_simulate_proposal", ...(proposalEnabled ? [...PROPOSAL_TOOL_NAMES] : [])],
          automationEnabled: false,
          foundationDbReadToolsEnabled: governanceToolsEnabled,
          foundationDbWriteToolsEnabled: governanceToolsEnabled,
          // The field-collection tool is its own read-only surface inside foundationDb mode.
          foundationDbCollectToolsEnabled: governanceToolsEnabled,
          foundationDbFeedbackToolsEnabled: governanceToolsEnabled,
          identityBindToolsEnabled: governanceToolsEnabled,
          proposalToolsEnabled: proposalEnabled && !governanceToolsEnabled,
          formalProposalActionsEnabled: false,
          integrations: {
            chat: governanceToolsEnabled ? "host-context-only" : proposalEnabled ? "host-context-only" : "not-connected",
            memberRegistry: governanceToolsEnabled ? "backend-read-only" : "not-connected",
            website: "not-connected",
            finance: governanceToolsEnabled ? "backend-snapshot-read-only" : "not-connected",
            identityBinding: governanceToolsEnabled ? "backend-host-context-only" : "not-connected",
          },
          pending: governanceToolsEnabled
            ? ["ballot-audit-export", "activity-follow-up-adapter", "website-publishing-adapter"]
            : ["authoritative-member-registry-adapter", "live-voting-adapter", "activity-follow-up-adapter", "website-publishing-adapter"],
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
        };
      },
    });
    // The synthetic simulators stay in the default development entry only. governance mode hides them
    // because a rehearsal of invented rules is not part of the real identity/funds slice.
    if (governanceToolsEnabled) return;
    api.registerTool({
      name: "rein_simulate_vote",
      description: "Simulate a synthetic governance round with explicitly supplied rules and ballots. Advisory rehearsal only; does not verify identities, record votes, reserve money or announce an official result.",
      parameters: Type.Object({
        roundJson: Type.String({ maxLength: 50000, description: "JSON round snapshot for synthetic rehearsal; must include explicit rules" }),
        ballotsJson: Type.String({ maxLength: 50000, description: "JSON array of synthetic ballots" }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, args) {
        try {
          const round = JSON.parse(args.roundJson);
          const ballots = JSON.parse(args.ballotsJson);
          if (!Array.isArray(ballots) || ballots.length > 200) throw new Error("ballots must be an array of at most 200 items");
          if (!Array.isArray(round.roster) || round.roster.length > 100 || !Array.isArray(round.proposals) || round.proposals.length > 50) {
            throw new Error("round roster or proposal count exceeds rehearsal limits");
          }
          let state = createRound(round);
          const receipts = [];
          for (const ballot of ballots) {
            const receipt = castBallot(state, ballot);
            receipts.push({ accepted: receipt.accepted, reason: receipt.reason ?? null });
            state = receipt.state;
          }
          const details = { simulationOnly: true, receipts, result: tallyRound(state) };
          return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          const details = { simulationOnly: true, error: error instanceof Error ? error.message : String(error) };
          return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
        }
      },
    });
    api.registerTool({
      name: "rein_simulate_proposal",
      description: "Check a synthetic proposal for missing information and suggested routing. No identity verification, policy authorization, submission or approval occurs.",
      parameters: Type.Object({
        fieldsJson: Type.String({ maxLength: 50000, description: "JSON proposal fields for rehearsal only" }),
        now: Type.String({ description: "Current ISO timestamp for schedule checks" }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, args) {
        try {
          const fields = JSON.parse(args.fieldsJson);
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object');
          const completeness = checkCompleteness(fields);
          const schedule = validateSchedule(fields, { now: args.now });
          const route = routeProcessingPath({ fields, completeness, schedule, policy: null });
          const details = { simulationOnly: true, completeness, schedule, route };
          return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          const details = { simulationOnly: true, error: error instanceof Error ? error.message : String(error) };
          return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
        }
      },
    });
  },
});
