// js/i18n-service.js

const LANG_STORAGE_KEY = 'dnd5e_vtt_lang';
const DEFAULT_ENGINE_LANG = 'eng';

class I18nService {
	constructor() {
		this.activeLang = localStorage.getItem(LANG_STORAGE_KEY) || DEFAULT_ENGINE_LANG;
		this.dictionaries = new Map();
		this.listeners = new Set();
	}

	getLang() {
		return this.activeLang;
	}

	onChange(callback) {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	notifyChange() {
		for (const cb of this.listeners) {
			cb(this.activeLang);
		}
	}

	async loadDictionary(lang) {
		const target = lang || DEFAULT_ENGINE_LANG;
		if (this.dictionaries.has(target)) {
			return this.dictionaries.get(target);
		}

		const url = new URL(`../i18n/${target}.json`, import.meta.url).href;
		const res = await fetch(url, {cache: 'no-cache'});
		if (!res.ok) {
			throw new Error(`Failed to load language pack: i18n/${target}.json (${res.status})`);
		}
		const dict = await res.json();
		this.dictionaries.set(target, dict);
		return dict;
	}

	async init(rootEl = document.documentElement) {
		await this.setLanguage(this.activeLang, rootEl);
	}

	async setLanguage(newLang, rootEl = document.documentElement) {
		const targetLang = newLang || DEFAULT_ENGINE_LANG;
		this.activeLang = targetLang;

		if (targetLang === DEFAULT_ENGINE_LANG) {
			localStorage.removeItem(LANG_STORAGE_KEY);
		} else {
			localStorage.setItem(LANG_STORAGE_KEY, targetLang);
		}

		try {
			await this.loadDictionary(targetLang);
		} catch (err) {
			console.warn(err.message);
			if (targetLang !== DEFAULT_ENGINE_LANG) {
				try { await this.loadDictionary(DEFAULT_ENGINE_LANG); } catch (_) {}
			}
		}

		this.translateDom(rootEl);
		this.notifyChange();
		return this.activeLang;
	}

	resolveKey(dict, keyPath) {
		if (!dict || !keyPath) return undefined;
		return keyPath.split('.').reduce((acc, part) => (acc !== undefined && acc !== null ? acc[part] : undefined), dict);
	}

	t(keyPath, fallback = '', vars = {}) {
		const activeDict = this.dictionaries.get(this.activeLang);
		let raw = this.resolveKey(activeDict, keyPath);

		if (raw === undefined) {
			const engDict = this.dictionaries.get(DEFAULT_ENGINE_LANG);
			raw = this.resolveKey(engDict, keyPath);
		}
		if (raw === undefined) {
			raw = fallback || keyPath;
		}

		return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
	}

	translateDom(rootEl = document.documentElement) {
		if (!rootEl) return;
		document.documentElement.lang = this.activeLang === 'ita' ? 'it' : 'en';

		rootEl.querySelectorAll('[data-i18n]').forEach((el) => {
			const key = el.getAttribute('data-i18n');
			const val = this.t(key, el.textContent || '');
			el.textContent = val;
		});

		rootEl.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
			const key = el.getAttribute('data-i18n-placeholder');
			const val = this.t(key, el.getAttribute('placeholder') || '');
			el.setAttribute('placeholder', val);
		});

		rootEl.querySelectorAll('[data-i18n-title]').forEach((el) => {
			const key = el.getAttribute('data-i18n-title');
			const val = this.t(key, el.getAttribute('title') || '');
			el.setAttribute('title', val);
		});

		rootEl.querySelectorAll('select[data-action="switchLanguage"]').forEach((sel) => {
			if (sel.value !== this.activeLang) {
				sel.value = this.activeLang;
			}
		});
	}
}

export const i18nService = new I18nService();