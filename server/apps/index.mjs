import { AgentContext } from '../agent/index.mjs';
import { adapter as cursorAdapter, methods as cursorMethods } from './cursor.mjs';
import { adapter as devinAdapter, methods as devinMethods } from './devin.mjs';
import { adapter as codexAdapter, methods as codexMethods } from './codex.mjs';

export const ADAPTERS = {
  cursor: cursorAdapter,
  devin: { ...cursorAdapter, ...devinAdapter },
  codex: { ...cursorAdapter, ...codexAdapter },
};
Object.assign(AgentContext.prototype, cursorMethods, devinMethods, codexMethods);
Object.defineProperty(AgentContext.prototype, 'adapter', { get() { return ADAPTERS[this.app] || ADAPTERS.cursor; }, configurable: true });
