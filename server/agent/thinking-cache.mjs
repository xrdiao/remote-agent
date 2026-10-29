export function resetThinkingCaches(context) {
  context.thinking = new Map();
  context.thinkingTried = new Map();
  context.keptThink = new Map();
  context.thinkLiveSeen = new Set();
  context.thinkFinal = new Set();
}
