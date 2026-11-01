// js/i18n-service.js

const LANG_STORAGE_KEY = 'dnd5e_vtt_lang';
const DEFAULT_ENGINE_LANG = 'eng';

class I18nService {
	constructor() {
		this.activeLang = localStorage.getItem(LANG_STORAGE_KEY) || DEFAULT_ENGINE_LANG;
		this.dictionaries = new Map(); // lang -> JSON object
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

	/**
	 * Scarica il dizionario JSON solo se la lingua è diversa dall'inglese ("eng").
	 */
	async loadDictionary(lang) {
		if (!lang || lang === DEFAULT_ENGINE_LANG) return null;
		if (this.dictionaries.has(lang)) {
			return this.dictionaries.get(lang);
		}

		const url = new URL(`../i18n/${lang}.json`, import.meta.url).href;
		const res = await fetch(url, {cache: 'no-cache'});
		if (!res.ok) {
			throw new Error(`Impossibile caricare il file lingua: i18n/${lang}.json (${res.status})`);
		}
		const dict = await res.json();
		this.dictionaries.set(lang, dict);
		return dict;
	}

	/**
	 * Cambia la lingua attiva, la salva in localStorage (o pulisce la chiave se si torna a "eng")
	 * e aggiorna automaticamente tutti i nodi [data-i18n] presenti nella pagina.
	 */
	async setLanguage(newLang, rootEl = document.body) {
		const targetLang = newLang || DEFAULT_ENGINE_LANG;
		this.activeLang = targetLang;

		if (targetLang === DEFAULT_ENGINE_LANG) {
			localStorage.removeItem(LANG_STORAGE_KEY);
		} else {
			localStorage.setItem(LANG_STORAGE_KEY, targetLang);
			try {
				await this.loadDictionary(targetLang);
			} catch (err) {
				console.warn(err.message);
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

	/**
	 * Traduce una chiave per i messaggi dinamici generati via JS (es. stato DB o notifiche toast),
	 * usando fallbackEng quando la lingua è "eng" o la chiave non è presente nel JSON.
	 */
	t(keyPath, fallbackEng = '', vars = {}) {
		let raw = fallbackEng;
		if (this.activeLang !== DEFAULT_ENGINE_LANG) {
			const dict = this.dictionaries.get(this.activeLang);
			const found = this.resolveKey(dict, keyPath);
			if (found !== undefined) {
				raw = found;
			}
		}
		return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
	}

	/**
	 * Traduce tutti gli elementi [data-i18n], [data-i18n-placeholder] e [data-i18n-title] dentro rootEl.
	 * Al primo passaggio memorizza sul nodo stesso il testo inglese nativo dell'HTML.
	 */
	translateDom(rootEl = document.body) {
		if (!rootEl) return;
		document.documentElement.lang = this.activeLang === 'ita' ? 'it' : 'en';

		const dict = this.activeLang !== DEFAULT_ENGINE_LANG ? this.dictionaries.get(this.activeLang) : null;

		rootEl.querySelectorAll('[data-i18n]').forEach((el) => {
			if (el._defaultEngText === undefined) {
				el._defaultEngText = el.textContent;
			}
			const key = el.getAttribute('data-i18n');
			const translated = dict ? this.resolveKey(dict, key) : undefined;
			el.textContent = translated !== undefined ? translated : el._defaultEngText;
		});

		rootEl.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
			if (el._defaultEngPlaceholder === undefined) {
				el._defaultEngPlaceholder = el.getAttribute('placeholder') || '';
			}
			const key = el.getAttribute('data-i18n-placeholder');
			const translated = dict ? this.resolveKey(dict, key) : undefined;
			el.setAttribute('placeholder', translated !== undefined ? translated : el._defaultEngPlaceholder);
		});

		rootEl.querySelectorAll('[data-i18n-title]').forEach((el) => {
			if (el._defaultEngTitle === undefined) {
				el._defaultEngTitle = el.getAttribute('title') || '';
			}
			const key = el.getAttribute('data-i18n-title');
			const translated = dict ? this.resolveKey(dict, key) : undefined;
			el.setAttribute('title', translated !== undefined ? translated : el._defaultEngTitle);
		});

		rootEl.querySelectorAll('select[data-action="switchLanguage"]').forEach((sel) => {
			if (sel.value !== this.activeLang) {
				sel.value = this.activeLang;
			}
		});
	}
}

export const i18nService = new I18nService();