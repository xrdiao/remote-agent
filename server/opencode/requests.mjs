// OpenCode may retain a pending request after its exact tool was aborted.
// This is a read-only view: preserve the native request Maps and never reply.
export function isAbortedOpenCodeRequest(request, messages, sessionID, receipt = '') {
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
  const time = value => Number.isFinite(value) && value > 0;
  if (!id(sessionID) || !id(request?.id) || request.sessionID !== sessionID
      || !id(request.tool?.messageID) || !id(request.tool?.callID) || !Array.isArray(messages)) return false;
  const matches = messages.filter(row => row.info?.id === request.tool.messageID);
  if (matches.length !== 1) return false;
  const { info, parts } = matches[0];
  if (info.sessionID !== sessionID || info.role !== 'assistant' || info.synthetic || !id(info.parentID)
      || receipt && info.parentID !== receipt || info.error?.name !== 'MessageAbortedError'
      || info.error?.data?.message !== 'Aborted' || !time(info.time?.created) || !time(info.time?.completed)
      || info.time.completed < info.time.created) return false;
  const parents = messages.filter(row => row.info?.id === info.parentID);
  if (parents.length !== 1 || parents[0].info.role !== 'user' || parents[0].info.sessionID !== sessionID
      || parents[0].info.synthetic || !time(parents[0].info.time?.created)
      || parents[0].info.time.created > info.time.created) return false;
  const values = parts instanceof Map ? [...parts.values()] : parts;
  if (!Array.isArray(values) || values.some(part => part.type === 'tool'
      && !['completed', 'error'].includes(part.state?.status))) return false;
  const calls = values.filter(part => part.type === 'tool' && part.callID === request.tool.callID);
  if (calls.length !== 1) return false;
  const part = calls[0], state = part.state;
  return part.sessionID === sessionID && part.messageID === info.id && id(part.id) && id(part.tool)
    && state?.status === 'error' && state.error === 'Tool execution aborted'
    && time(state.time?.start) && time(state.time?.end) && state.time.start >= info.time.created
    && state.time.end >= state.time.start && state.time.end <= info.time.completed;
}
