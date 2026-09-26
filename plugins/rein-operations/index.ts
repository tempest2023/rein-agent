import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRound, castBallot, tallyRound } from "./governance.ts";
import { checkCompleteness, validateSchedule, routeProcessingPath } from "./proposals.ts";
import { createProposalStore } from "./proposal-store.ts";
import { createProposalToolRegistration, PROPOSAL_TOOL_NAMES } from "./proposal-tool-bridge.ts";
import { createMvpReadToolRegistration, MVP_READ_TOOL_NAMES } from "./mvp-read-tools.ts";
import { createMvpWriteToolRegistration, MVP_WRITE_TOOL_NAMES } from "./mvp-write-tools.ts";
import { createMvpFeedbackToolRegistration, MVP_FEEDBACK_TOOL_NAMES } from "./mvp-feedback-tools.ts";

// This first tool proves the external-plugin boundary without enabling business actions.
export default definePluginEntry({
  id: "rein-operations",
  name: "Rein Operations",
  description: "Rein Protocol Foundation operations extension",
  register(api) {
    const proposalConfig = api.pluginConfig?.proposalTools;
    const proposalEnabled = Boolean(proposalConfig && typeof proposalConfig === 'object' && (proposalConfig as Record<string, unknown>).enabled === true);
    const mvpConfig = api.pluginConfig?.mvp;
    const mvpEnabled = Boolean(mvpConfig && typeof mvpConfig === 'object' && (mvpConfig as Record<string, unknown>).enabled === true);
    if (mvpEnabled) {
      // MVP mode exposes the database-backed read and write tools instead of the synthetic
      // simulators and the legacy local-ledger proposal tools. Configuration is validated here so
      // an enabled but incomplete block fails loudly; the Supabase key is read from the server
      // environment and never stored in plugin config.
      api.registerTool(createMvpReadToolRegistration({ config: mvpConfig as Record<string, unknown> }), {
        names: [...MVP_READ_TOOL_NAMES],
      });
      api.registerTool(createMvpWriteToolRegistration({ config: mvpConfig as Record<string, unknown> }), {
        names: [...MVP_WRITE_TOOL_NAMES],
      });
      // Post-result feedback registers with the same explicit block: a comment or suggested
      // revision, a director's approval of a material revision, and the guarded apply step. The
      // database refuses a material revision until a current director's approval is recorded.
      api.registerTool(createMvpFeedbackToolRegistration({ config: mvpConfig as Record<string, unknown> }), {
        names: [...MVP_FEEDBACK_TOOL_NAMES],
      });
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
          implemented: mvpEnabled
            ? ["rein_status", ...MVP_READ_TOOL_NAMES, ...MVP_WRITE_TOOL_NAMES, ...MVP_FEEDBACK_TOOL_NAMES]
            : ["rein_status", "rein_simulate_vote", "rein_simulate_proposal", ...(proposalEnabled ? [...PROPOSAL_TOOL_NAMES] : [])],
          automationEnabled: false,
          mvpReadToolsEnabled: mvpEnabled,
          mvpWriteToolsEnabled: mvpEnabled,
          mvpFeedbackToolsEnabled: mvpEnabled,
          proposalToolsEnabled: proposalEnabled && !mvpEnabled,
          formalProposalActionsEnabled: false,
          integrations: {
            chat: mvpEnabled ? "host-context-only" : proposalEnabled ? "host-context-only" : "not-connected",
            memberRegistry: mvpEnabled ? "database-read-only" : "not-connected",
            website: "not-connected",
            finance: mvpEnabled ? "snapshot-read-only" : "not-connected",
          },
          pending: mvpEnabled
            ? ["production-slack-app", "ballot-audit-export", "activity-follow-up-adapter", "website-publishing-adapter"]
            : ["authoritative-member-registry-adapter", "live-voting-adapter", "activity-follow-up-adapter", "website-publishing-adapter"],
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
        };
      },
    });
    // The synthetic simulators stay in the default development entry only. MVP mode hides them
    // because a rehearsal of invented rules is not part of the real identity/funds slice.
    if (mvpEnabled) return;
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
