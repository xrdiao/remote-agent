import { SessionBinding } from '../session/binding.mjs';
import { AGENT_REGISTRY } from '../apps/index.mjs';
import { methods as chat } from './chat.mjs';
import { methods as files } from './files.mjs';
import { methods as projects } from './projects.mjs';
import { methods as menus } from './menus.mjs';
import { methods as sessionActions } from './session-actions.mjs';

function composeServices() {
  class AgentServices {}
  const prototype = AgentServices.prototype;
  SessionBinding.defineProperties(prototype);
  const add = (name, descriptor) => {
    if (name in prototype) throw new Error(`Duplicate AgentContext service: ${name}`);
    Object.defineProperty(prototype, name, { configurable: true, ...descriptor });
  };

  for (const group of [chat, files, projects, menus, sessionActions])
    for (const [name, method] of Object.entries(group)) add(name, { value: method, writable: true });

  // Legacy method names resolve against the selected app on every access. A
  // Session can change apps without carrying methods from its previous binding.
  const appMethodNames = new Set(Object.values(AGENT_REGISTRY).flatMap(entry => Object.keys(entry.methods)));
  for (const name of appMethodNames)
    add(name, { get() { return AGENT_REGISTRY[this.app]?.methods[name]; } });

  return AgentServices;
}

export const AgentServices = composeServices();
