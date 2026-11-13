import '../app/js/shared-rules.js';
export const { desktopAction, parseSessionRef, isLocalFileReference, codeBlockHtml, notificationTarget, notificationKey,
  titleParts, cleanWindowTitle, parseWindowTitle, normalizeReceiptText, withoutAttachmentLabels, textExtensions, documentExtensions, imageTypes, previewImageTypes, uploadAccept, uploadDocument } = globalThis.RemoteAgentRules;

export function elicitationFields(schemaDefinition, fields = null) {
  const optionsFor = schema => {
    const field = schema.type === 'array' ? schema.items : schema;
    return field.enum ? field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? String(value) }))
      : (field.oneOf || field.anyOf)?.map(option => ({ value: option.const, label: option.title }));
  };
  if (fields === null) return Object.entries(schemaDefinition?.properties || {}).map(([name, schema]) => {
    const multiple = schema.type === 'array', options = optionsFor(schema);
    return { label: schema.title || name, type: 'text',
      value: multiple ? (schema.default || []).map(String) : schema.default == null ? '' : String(schema.default),
      ...(multiple ? { multiple: true } : {}),
      options: options ? [...(multiple ? [] : [{ value: '', label: '请选择' }]),
        ...options.map(option => ({ ...option, value: String(option.value) }))]
        : schema.type === 'boolean' ? [{ value: '', label: '请选择' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }] : null,
    };
  });
  const content = {};
  for (const [i, [name, schema]] of Object.entries(schemaDefinition?.properties || {}).entries()) {
    const value = fields.find(field => field.n === i)?.value ?? '';
    if ((value === '' || Array.isArray(value) && !value.length) && !(schemaDefinition.required || []).includes(name)) continue;
    let typed = value;
    const options = optionsFor(schema);
    const selected = value => {
      const option = options.find(option => String(option.value) === value);
      if (!option) throw new Error('请选择有效的 ' + name);
      return option.value;
    };
    if (schema.type === 'array') {
      typed = value.map(selected);
      if (schema.minItems != null && typed.length < schema.minItems || schema.maxItems != null && typed.length > schema.maxItems)
        throw new Error(name + ' 的选项数量不符合要求');
    } else if (options) {
      typed = selected(value);
    } else if (schema.type === 'boolean') {
      if (!['true', 'false'].includes(value)) throw new Error(name + ' 必须为 true 或 false');
      typed = value === 'true';
    } else if (schema.type === 'integer' || schema.type === 'number') {
      typed = Number(value);
      if (!String(value).trim() || !Number.isFinite(typed) || schema.type === 'integer' && !Number.isInteger(typed))
        throw new Error(name + ' 的数值格式不正确');
    }
    content[name] = typed;
  }
  return content;
}
