'use strict';

/**
 * Tests for the i18n service.
 *
 * Pure unit tests — no external dependencies. Covers all supported locales,
 * the unknown-locale fallback, interpolation, unknown keys, and edge cases.
 */

const { t, translations } = require('../src/services/i18n');

describe('i18n — t()', () => {
  describe('supported locales', () => {
    const SUPPORTED = ['en', 'fr', 'es', 'pt', 'tpi', 'ha'];

    it.each(SUPPORTED)('%s locale has a greeting key', (locale) => {
      const result = t(locale, 'greeting');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it.each(SUPPORTED)('%s locale has all required keys', (locale) => {
      const REQUIRED_KEYS = [
        'greeting', 'feeReminder', 'school', 'feeAmount', 'amountDue',
        'payPrompt', 'thanks', 'administration', 'unsubscribeText', 'reminderNote',
      ];
      for (const key of REQUIRED_KEYS) {
        expect(t(locale, key)).toBeTruthy();
      }
    });
  });

  describe('unknown locale fallback', () => {
    it('falls back to English for an unsupported locale code', () => {
      expect(t('zz', 'greeting')).toBe(t('en', 'greeting'));
    });

    it('falls back to English for an empty locale string', () => {
      expect(t('', 'greeting')).toBe(t('en', 'greeting'));
    });

    it('falls back to English for null locale', () => {
      expect(t(null, 'greeting')).toBe(t('en', 'greeting'));
    });

    it('falls back to English for undefined locale', () => {
      expect(t(undefined, 'greeting')).toBe(t('en', 'greeting'));
    });
  });

  describe('unknown key handling', () => {
    it('returns empty string for an unknown key in any locale', () => {
      expect(t('en', 'nonExistentKey')).toBe('');
      expect(t('fr', 'nonExistentKey')).toBe('');
    });

    it('returns empty string for an unknown key in an unknown locale (double fallback)', () => {
      expect(t('xx', 'totallyMissingKey')).toBe('');
    });
  });

  describe('interpolation', () => {
    it('interpolates {{n}} in reminderNote', () => {
      const result = t('en', 'reminderNote', { n: 3 });
      expect(result).toContain('3');
      expect(result).not.toContain('{{n}}');
    });

    it('interpolates correctly in French', () => {
      const result = t('fr', 'reminderNote', { n: 5 });
      expect(result).toContain('5');
      expect(result).not.toContain('{{n}}');
    });

    it('interpolates correctly in all supported locales', () => {
      const SUPPORTED = ['en', 'fr', 'es', 'pt', 'tpi', 'ha'];
      for (const locale of SUPPORTED) {
        const result = t(locale, 'reminderNote', { n: 1 });
        expect(result).toContain('1');
        expect(result).not.toContain('{{n}}');
      }
    });

    it('replaces placeholder with empty string when var is null', () => {
      const result = t('en', 'reminderNote', { n: null });
      expect(result).not.toContain('{{n}}');
    });

    it('replaces placeholder with empty string when var is undefined', () => {
      const result = t('en', 'reminderNote', { n: undefined });
      expect(result).not.toContain('{{n}}');
    });

    it('returns template unchanged when no vars are provided', () => {
      const raw = translations.en.greeting;
      expect(t('en', 'greeting')).toBe(raw);
    });

    it('ignores extra vars that have no placeholder', () => {
      const result = t('en', 'greeting', { foo: 'bar', baz: 42 });
      expect(result).toBe(translations.en.greeting);
    });
  });

  describe('locale differentiation', () => {
    it('French greeting differs from English', () => {
      expect(t('fr', 'greeting')).not.toBe(t('en', 'greeting'));
    });

    it('Spanish greeting differs from English', () => {
      expect(t('es', 'greeting')).not.toBe(t('en', 'greeting'));
    });

    it('each locale returns its own feeReminder string', () => {
      const locales = ['en', 'fr', 'es', 'pt', 'tpi', 'ha'];
      const results = locales.map((l) => t(l, 'feeReminder'));
      // All 6 should be unique strings (no two locales have identical feeReminder)
      const unique = new Set(results);
      expect(unique.size).toBe(locales.length);
    });
  });

  describe('translations export', () => {
    it('exports the raw translations dictionary', () => {
      expect(translations).toBeDefined();
      expect(typeof translations).toBe('object');
      expect(translations.en).toBeDefined();
      expect(translations.fr).toBeDefined();
    });
  });
});
