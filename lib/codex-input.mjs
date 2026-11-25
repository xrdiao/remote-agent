// A native input receipt keeps every typed block and every JSON field. Only
// object key order is canonicalized; text, whitespace and array order are exact.
export function codexInputKey(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100
      || input.some(block => !block || Array.isArray(block) || typeof block !== 'object'
        || typeof block.type !== 'string' || !block.type || block.type.length > 100)) return null;
  let count = 0;
  const visit = (value, depth) => {
    if (++count > 10000 || depth > 16) throw Error('native_input_too_complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > 64000 || !value.isWellFormed()) throw Error('invalid_native_input_string');
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 1000 || Object.keys(value).length !== value.length) throw Error('invalid_native_input_array');
      return value.map(item => visit(item, depth + 1));
    }
    if (Object.prototype.toString.call(value) !== '[object Object]') throw Error('invalid_native_input_value');
    return Object.fromEntries(Object.keys(value).sort().map(key => {
      if (key.length > 1000 || !key.isWellFormed()) throw Error('invalid_native_input_key');
      return [key, visit(value[key], depth + 1)];
    }));
  };
  try {
    const key = JSON.stringify(visit(input, 0));
    return new TextEncoder().encode(key).length <= 64000 ? key : null;
  } catch { return null; }
}
