// OpenCode question options are native labels, not arbitrary object strings.
// Keep the same public snapshot for new and reused native sessions.
export function normalizeOpenCodeQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 20)
    throw Error('invalid_native_question');
  const text = (value, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || required && !value.trim())
      throw Error('invalid_native_question');
    return value;
  };
  return questions.map(question => {
    if (!question || typeof question !== 'object' || Array.isArray(question))
      throw Error('invalid_native_question');
    const result = { question: text(question.question, 2000, true) };
    if (question.header !== undefined) result.header = text(question.header, 500);
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length > 20)
        throw Error('invalid_native_question');
      result.options = question.options.map(option => text(
        typeof option === 'string' ? option : option?.label, 500, true));
      if (question.options.some(option => typeof option === 'object' && option?.description !== undefined))
        result.optionDescriptions = question.options.map(option =>
          typeof option === 'object' && option?.description !== undefined ? text(option.description, 2000) : '');
    }
    if (question.multiple !== undefined) {
      if (typeof question.multiple !== 'boolean') throw Error('invalid_native_question');
      result.allowMultiple = question.multiple;
    }
    if (question.custom !== undefined) {
      if (typeof question.custom !== 'boolean') throw Error('invalid_native_question');
      result.allowCustom = question.custom;
    }
    return result;
  });
}

export function validateOpenCodeAnswers(answers, questions) {
  if (!Array.isArray(answers) || !answers.length || answers.length !== questions.length || answers.length > 20)
    throw Error('invalid_question_answers');
  return answers.map((entry, index) => {
    const question = questions[index];
    if (!Array.isArray(entry) || !entry.length || entry.length > 20
        || question.allowMultiple !== true && entry.length !== 1)
      throw Error('invalid_question_answers');
    return entry.map(value => {
      if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\0\r\n]/.test(value)
          || question.allowCustom === false && !question.options?.includes(value))
        throw Error('invalid_question_answers');
      return value;
    });
  });
}

// A rejected question can end an OpenCode turn with finish:"tool-calls" and
// no assistant reply. This is evidence of native dismissal, not completion.
export function openCodeQuestionRejection({ messages, sessionID, receipt, idle }) {
  if (!idle || !Array.isArray(messages) || !receipt || !sessionID) return null;
  const at = messages.findIndex(row => row.info?.id === receipt && row.info.role === 'user');
  if (at < 0 || messages.slice(at + 1).some(row => row.info?.role === 'user')) return null;
  const last = messages.slice(at + 1).at(-1), info = last?.info;
  if (info?.role !== 'assistant' || info.parentID !== receipt || info.finish !== 'tool-calls'
      || info.error || info.synthetic || !Number.isFinite(info.time?.completed) || info.time.completed <= 0) return null;
  const parts = last.parts instanceof Map ? [...last.parts.values()] : last.parts;
  if (!Array.isArray(parts) || parts.some(part => part.type === 'tool' && !['completed', 'error'].includes(part.state?.status))) return null;
  const rejected = parts.filter(part => part.type === 'tool' && part.tool === 'question'
    && part.state?.status === 'error' && part.state.error === 'The user dismissed this question');
  if (rejected.length !== 1) return null;
  const part = rejected[0];
  if (part.sessionID !== sessionID || part.messageID !== info.id || typeof part.callID !== 'string' || !part.callID
      || part.callID.length > 300 || !Number.isFinite(part.state.time?.end) || part.state.time.end <= 0
      || info.time.completed < part.state.time.end) return null;
  return { sessionID, receipt, messageID: info.id, callID: part.callID, completed: info.time.completed,
    error: 'The user dismissed this question' };
}

// Permission rejection can also end at an errored tool call with no final text.
// Return only exact native turn/tool metadata; no tool input or reasoning.
export function openCodePermissionRejection({ messages, sessionID, receipt, idle }) {
  if (!idle || !Array.isArray(messages) || !receipt || !sessionID) return null;
  const at = messages.findIndex(row => row.info?.id === receipt && row.info.role === 'user');
  if (at < 0 || messages.slice(at + 1).some(row => row.info?.role === 'user')) return null;
  const last = messages.slice(at + 1).at(-1), info = last?.info;
  if (info?.role !== 'assistant' || info.parentID !== receipt || info.finish !== 'tool-calls'
      || info.error || info.synthetic || !Number.isFinite(info.time?.completed) || info.time.completed <= 0) return null;
  const parts = last.parts instanceof Map ? [...last.parts.values()] : last.parts;
  if (!Array.isArray(parts) || parts.some(part => part.type === 'tool' && !['completed', 'error'].includes(part.state?.status))) return null;
  const rejected = parts.filter(part => part.type === 'tool' && part.state?.status === 'error'
    && part.state.error === 'The user rejected permission to use this specific tool call.');
  if (rejected.length !== 1) return null;
  const part = rejected[0];
  if (part.sessionID !== sessionID || part.messageID !== info.id || typeof part.callID !== 'string' || !part.callID
      || part.callID.length > 300 || !Number.isFinite(part.state.time?.end) || part.state.time.end <= 0
      || info.time.completed < part.state.time.end) return null;
  return { sessionID, receipt, messageID: info.id, callID: part.callID, completed: info.time.completed,
    error: 'The user rejected permission to use this specific tool call.' };
}
