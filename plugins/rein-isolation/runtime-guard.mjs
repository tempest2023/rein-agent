import { isAbsolute, relative, sep, dirname, join } from 'node:path';
import { existsSync, realpathSync, readdirSync, lstatSync } from 'node:fs';

export function assertIsolatedRuntime(cfg, config, workspaceDir, { platform, publicTools, publicReferences = [], publicSkills = [] }) {
  let parent = dirname(config.memoryPath);
  const suffix = [];
  while (!existsSync(parent)) { suffix.unshift(parent.split(sep).at(-1)); parent = dirname(parent); }
  const physicalMemory = join(realpathSync(parent), ...suffix, config.memoryPath.split(sep).at(-1));
  const inside = relative(realpathSync(workspaceDir), physicalMemory);
  if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error('Private memory must be outside the public workspace');
  if (cfg.plugins?.entries?.[platform]?.enabled !== false) throw new Error('Disable the bundled channel plugin before enabling the isolated adapter');
  if (cfg.memory?.search?.enabled !== false || cfg.memory?.search?.rememberAcrossConversations !== false ||
      cfg.agents?.defaults?.compaction?.memoryFlush?.enabled !== false) throw new Error('Shared native memory must be disabled');
  if (cfg.agents?.defaults?.skipBootstrap !== true) throw new Error('Dedicated public workspace must disable automatic bootstrap creation');
  if (cfg.tools?.fs?.workspaceOnly !== true || cfg.tools?.sessions?.visibility !== 'self' || cfg.tools?.agentToAgent?.enabled !== false) {
    throw new Error('Rein channel requires confined filesystem and session tools');
  }
  if (!Array.isArray(cfg.tools?.allow) || cfg.tools.allow.some(name => !publicTools.includes(name))) {
    throw new Error('Rein channel requires an explicit profile-scoped tool allowlist');
  }
  if (cfg.tools?.alsoAllow?.length || cfg.tools?.byProvider || cfg.skills?.load?.extraDirs?.length ||
      cfg.plugins?.slots?.contextEngine) throw new Error('Tool, skill-directory and context-engine overrides are unsupported');
  if (cfg.session?.groupScope === 'main' || Object.entries(cfg.channels ?? {}).some(([name,value]) =>
      ![platform,'defaults'].includes(name) && value?.enabled !== false)) throw new Error('Use a dedicated channel profile with separate room sessions');
  if (Object.values(cfg.models?.providers ?? {}).some(provider => provider.agentRuntime ||
      provider.models?.some(model => model.agentRuntime)) || cfg.agents?.defaults?.cliBackends ||
      Object.values(cfg.agents?.defaults?.models ?? {}).some(model => model.agentRuntime)) throw new Error('Alternate provider/model agent runtimes are unsupported');
  // This adapter is deliberately one dedicated agent/account. Agent overrides,
  // channel bindings and shared alternate harnesses would invalidate the audited boundary.
  // The host migrates an omitted roster to { main: {} } before registration.
  // Permit only that empty entry; every per-agent field and extra agent is unsupported.
  const entries = cfg.agents?.entries;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const emptyMain = record(entries) && Object.keys(entries).length === 1 &&
    Object.hasOwn(entries, 'main') && record(entries.main) && Object.keys(entries.main).length === 0;
  if (config.agentId !== 'main' || cfg.bindings?.length || cfg.agents?.list?.length || cfg.agents?.ownership !== undefined ||
      (entries !== undefined && !emptyMain) || cfg.channels?.[platform]?.accounts ||
      cfg.agents?.defaults?.memory || cfg.agents?.defaults?.tools) throw new Error('Agent/account/binding overrides are unsupported in the isolated profile');
  // This is a dedicated public-reference workspace, not an operator workspace.
  // Contents of these reviewed files are public; no runtime/transcript directory
  // or personal bootstrap file can be added without failing startup.
  const publicFiles = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'HEARTBEAT.md',
    'USER.md', 'community-directory.json', ...publicReferences]);
  for (const file of readdirSync(workspaceDir)) {
    const stat = lstatSync(join(workspaceDir, file));
    if (file === 'skills' && publicSkills.length) {
      // Only explicitly reviewed public skill instructions may enter a channel workspace.
      const skills = join(workspaceDir, file);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          readdirSync(skills).sort().join() !== [...publicSkills].sort().join())
        throw new Error('Workspace must contain only approved public reference files');
      for (const name of publicSkills) {
        const skill = join(skills, name);
        const directory = lstatSync(skill);
        if (!directory.isDirectory() || directory.isSymbolicLink() || readdirSync(skill).join() !== 'SKILL.md')
          throw new Error('Workspace must contain only approved public reference files');
        const leaf = lstatSync(join(skill, 'SKILL.md'));
        if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1)
          throw new Error('Workspace must contain only approved public reference files');
      }
      continue;
    }
    if (!publicFiles.has(file) || !stat.isFile() || stat.nlink !== 1) throw new Error('Workspace must contain only approved public reference files');
  }
}
