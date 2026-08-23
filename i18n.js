import { translations } from './translations.js';

export function getCurrentLanguage() {
    return localStorage.getItem('desimarket_lang') || 'en';
}

// Translate a single key (used for dynamically-generated content in JS template strings)
export function t(key) {
    const lang = getCurrentLanguage();
    return (translations[lang] && translations[lang][key]) || (translations.en[key]) || key;
}

// Applies translations to every element on the page tagged with data-i18n /
// data-i18n-placeholder attributes. Call this again after switching language.
export function applyTranslations() {
    const lang = getCurrentLanguage();
    const dict = translations[lang] || translations.en;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) el.textContent = dict[key];
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (dict[key]) el.setAttribute('placeholder', dict[key]);
    });

    document.documentElement.lang = lang;

    // Keep any language-toggle buttons on the page in sync
    document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
        btn.textContent = lang === 'hi' ? '🌐 English' : '🌐 हिंदी';
    });
}

// Switches the site language, persists it, and re-applies translations.
// Pass a callback if the page also needs to re-render dynamic (JS-built) content.
export function setLanguage(lang, onChanged) {
    localStorage.setItem('desimarket_lang', lang);
    applyTranslations();
    if (onChanged) onChanged();
}

export function toggleLanguage(onChanged) {
    const next = getCurrentLanguage() === 'hi' ? 'en' : 'hi';
    setLanguage(next, onChanged);
}
