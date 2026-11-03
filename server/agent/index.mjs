import { AgentContext } from './context.mjs';
import { methods as chat } from './chat.mjs';
import { methods as files } from './files.mjs';
import { methods as projects } from './projects.mjs';
import { methods as menus } from './menus.mjs';
import { methods as sessionActions } from './session-actions.mjs';

Object.assign(AgentContext.prototype, chat, files, projects, menus, sessionActions);

export * from './context.mjs';
export { safeHomePath, projectList, openFolder } from './projects.mjs';
