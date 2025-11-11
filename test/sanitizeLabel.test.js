import { describe, expect, it } from 'vitest';
import sanitizeLabel from '../src/utils/sanitizeLabel.js';

describe('sanitizeLabel', () => {
  it('escapes HTML special characters', () => {
    const input = `Biodiv & <script>"alert('xss')"</script>`;
    const result = sanitizeLabel(input);
    expect(result).toBe('Biodiv &amp; &lt;script&gt;&quot;alert(&#39;xss&#39;)&quot;&lt;/script&gt;');
  });

  it('keeps benign strings unchanged', () => {
    const input = 'Daun Hijau';
    expect(sanitizeLabel(input)).toBe(input);
  });

  it('handles nullish values by returning an empty string', () => {
    expect(sanitizeLabel(null)).toBe('');
    expect(sanitizeLabel(undefined)).toBe('');
  });
});
