import { AgentContext } from './context.mjs';
import { methods as chat } from './chat.mjs';
import { methods as terminal } from './terminal.mjs';
import { methods as files } from './files.mjs';
import { methods as projects } from './projects.mjs';
import { methods as menus } from './menus.mjs';
import { methods as fusion } from '../fusion/agent.mjs';

Object.assign(AgentContext.prototype, chat, terminal, files, projects, menus, fusion);

export * from './context.mjs';
export { safeHomePath, projectList, openFolder } from './projects.mjs';
