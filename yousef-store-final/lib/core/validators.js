// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = function createValidators(deps = {}) {
  const {  } = deps;
  // ---------------------------------------------------------------------------
  // أدوات مساعدة
  // ---------------------------------------------------------------------------
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);
  }
  const isEmail = value => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-zA-Z]{2,12}$/.test(String(value || '').trim());
  const isPhone = value => /^[0-9+\-\s()]{7,20}$/.test(String(value || '').trim());
  const asText = (value, max) => String(value ?? '').trim().slice(0, max);
  function validate(rules, body) {
    const errors = [];
    const output = {};
    for (const [field, rule] of Object.entries(rules)) {
      const raw = body ? body[field] : undefined;
      if (rule.required && (raw === undefined || raw === null || String(raw).trim() === '')) {
        errors.push(rule.label ? `${rule.label} مطلوب` : `${field} مطلوب`);
        continue;
      }
      if (raw === undefined || raw === null || raw === '') {
        output[field] = rule.default;
        continue;
      }
      if (rule.type === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          errors.push(`${rule.label || field} يجب أن يكون رقمًا`);
          continue;
        }
        if (rule.min !== undefined && num < rule.min) {
          errors.push(`${rule.label || field} يجب ألا يقل عن ${rule.min}`);
          continue;
        }
        if (rule.max !== undefined && num > rule.max) {
          errors.push(`${rule.label || field} يجب ألا يزيد عن ${rule.max}`);
          continue;
        }
        output[field] = num;
        continue;
      }
      if (rule.type === 'email' && !isEmail(raw)) {
        errors.push('البريد الإلكتروني غير صحيح');
        continue;
      }
      if (rule.type === 'phone' && !isPhone(raw)) {
        errors.push('رقم الهاتف غير صحيح');
        continue;
      }
      if (rule.enum && !rule.enum.includes(raw)) {
        errors.push(`${rule.label || field} غير صالح`);
        continue;
      }
      const text = String(raw);
      if (rule.minLength && text.trim().length < rule.minLength) {
        errors.push(`${rule.label || field} يجب ألا يقل عن ${rule.minLength} أحرف`);
        continue;
      }
      output[field] = rule.maxLength ? text.trim().slice(0, rule.maxLength) : text;
    }
    return {
      errors,
      value: output
    };
  }
  return { escapeHtml, isEmail, asText, validate };
};
