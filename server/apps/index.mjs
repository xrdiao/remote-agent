import { EDITORS } from '../config.mjs';
import { listWindows, codexWindows } from '../windows.mjs';
import * as cursor from './cursor.mjs';
import * as devin from './devin.mjs';
import * as codex from './codex.mjs';
import * as fusion from './fusion.mjs';
import * as opencode from './opencode.mjs';
import { openCode } from '../opencode/state.mjs';
import { defineAgentAdapter, unsupportedCapability } from './adapter.mjs';

const registry = Object.create(null);
const add = (metadata, { adapter, methods, capabilities, nativeCapabilities }) => {
  const app = metadata.app;
  if (registry[app]) throw new Error(`Duplicate agent adapter: ${app}`);
  registry[app] = defineAgentAdapter({ ...metadata, adapter, methods, capabilities, nativeCapabilities });
};

const editor = app => EDITORS.find(item => item.app === app);
add({ ...editor('cursor'), kind: 'window', discover: () => listWindows(null, 'cursor') }, cursor);
add({ ...editor('devin'), kind: 'window', discover: () => listWindows(null, 'devin') }, devin);
add({ ...editor('codex'), kind: 'window', discover: reportErrors => codexWindows(editor('codex').url, reportErrors) }, codex);
add({ app: 'opencode', name: 'OpenCode', kind: 'api', discover: () => openCode.discover() }, opencode);
add({ app: 'fusion', name: 'Fusion', kind: 'orchestrator' }, fusion);

export const AGENT_REGISTRY = Object.freeze(registry);
export const ADAPTERS = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(registry).map(([app, entry]) => [app, entry.adapter]))));

function selectedNative(context) {
  const entry = AGENT_REGISTRY[context.app];
  return entry?.native[context.codexBackend ? 'backend' : entry.kind];
}

export function runAdapterMethod(context, name, ...args) {
  const method = ADAPTERS[context.app]?.[name];
  if (typeof method !== 'function') throw unsupportedCapability(context.app, name);
  return method.call(context, ...args);
}

export function nativeCapability(context) {
  const capability = selectedNative(context);
  if (!capability) throw unsupportedCapability(context.app, 'native');
  return capability;
}

export function nativeRoute(context, type) {
  return selectedNative(context)?.routes[type];
}

export function runNativeAction(context, action, ...args) {
  const method = nativeCapability(context).actions[action];
  if (!method) throw unsupportedCapability(context.app, action);
  return method.call(context, ...args);
}

export function runNativeQueue(context, message) {
  const method = nativeCapability(context).queue[message.action];
  if (!method) throw unsupportedCapability(context.app, 'queue');
  return method.call(context, message);
}
