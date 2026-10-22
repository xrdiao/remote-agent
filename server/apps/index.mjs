import { EDITORS } from '../config.mjs';
import { listWindows, codexWindows } from '../windows.mjs';
import { AgentContext } from '../agent/index.mjs';
import { adapter as cursorAdapter, methods as cursorMethods, capabilities as cursorCapabilities } from './cursor.mjs';
import { adapter as devinAdapter, methods as devinMethods, capabilities as devinCapabilities } from './devin.mjs';
import { adapter as codexAdapter, methods as codexMethods, capabilities as codexCapabilities } from './codex.mjs';
import { adapter as fusionAdapter, capabilities as fusionCapabilities } from './fusion.mjs';

// Static registration references the existing discovery/configuration and adapter methods.
// Preserve the existing native overrides and shared defaults.
const implementations = {
  cursor: { adapter: cursorAdapter, methods: cursorMethods, capabilities: cursorCapabilities },
  devin: { adapter: { ...cursorAdapter, ...devinAdapter }, methods: devinMethods, capabilities: devinCapabilities },
  codex: { adapter: { ...cursorAdapter, ...codexAdapter }, methods: codexMethods, capabilities: codexCapabilities },
};
export const AGENT_REGISTRY = Object.fromEntries(EDITORS.map(editor => [editor.app, {
  ...editor,
  discover: editor.app === 'codex'
    ? reportErrors => codexWindows(editor.url, reportErrors)
    : () => listWindows(null, editor.app),
  ...implementations[editor.app],
}]));
AGENT_REGISTRY.fusion = {
  app: 'fusion', name: 'Fusion', kind: 'orchestrator',
  adapter: fusionAdapter, methods: {}, capabilities: fusionCapabilities,
};
export const ADAPTERS = Object.fromEntries(Object.entries(AGENT_REGISTRY).map(([app, entry]) => [app, entry.adapter]));
Object.assign(AgentContext.prototype, ...Object.values(AGENT_REGISTRY).map(entry => entry.methods));
Object.defineProperty(AgentContext.prototype, 'adapter', { get() { return ADAPTERS[this.app] || ADAPTERS.cursor; }, configurable: true });
