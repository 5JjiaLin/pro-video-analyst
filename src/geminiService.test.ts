import { describe, expect, it } from 'vitest';

import { validateAiRuntimeConfig } from './geminiService';

describe('validateAiRuntimeConfig', () => {
  it('rejects a missing session key', () => {
    expect(() => validateAiRuntimeConfig({ apiKey: '   ', modelName: 'gemini-3-flash-preview' }))
      .toThrow('请先输入本次会话使用的 Gemini API Key。');
  });

  it('trims the session key without persisting it', () => {
    expect(validateAiRuntimeConfig({ apiKey: '  session-key  ', modelName: 'gemini-3-flash-preview' }))
      .toEqual({ apiKey: 'session-key', modelName: 'gemini-3-flash-preview' });
  });
});
