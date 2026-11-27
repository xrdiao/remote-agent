// The optional MCP integration installs its durable task reader once.
let taskOwner = () => false;

export function registerNativeTaskOwnership(check) {
  taskOwner = check;
}

export function assertNativeSessionUnclaimedByTask(binding) {
  if (!binding.host && taskOwner(binding, { exact: true })) throw new Error('native_session_claimed');
}
