// js/db-service.js
import {APP_CONFIG} from './config.js';

class CompendiumDbService {
	constructor() {
		this.worker = null;
		this.reqCounter = 0;
		this.pendingRequests = new Map();
		this.statusListeners = new Set();
		this.activeLang = APP_CONFIG.DB.DEFAULT_LANG;
		this.entityCache = new Map();

		this.state = {
			status: 'idle', // "idle" | "initializing" | "downloading" | "decompressing" | "ready" | "error"
			pack: null,
			progress: 0,
			coreVersion: null,
			langVersion: null,
			activeLang: this.activeLang,
			i18nAttached: false,
			source: null,
			error: null
		};
	}

	/**
	 * Avvia il Web Worker in background senza bloccare l'interfaccia utente.
	 */
	init(lang = this.activeLang) {
		this.activeLang = lang;
		if (!this.worker) {
			const workerUrl = new URL('./db-worker.js', import.meta.url);
			this.worker = new Worker(workerUrl);

			this.worker.onmessage = (e) => {
				const msg = e.data;
				if (!msg) return;

				if (msg.type === 'DB_STATUS') {
					if (msg.status === 'ready') {
						this.entityCache.clear();
					}
					this.updateState({
						                 status: msg.status,
						                 pack: msg.pack ?? this.state.pack,
						                 progress: msg.progress ?? this.state.progress,
						                 coreVersion: msg.coreVersion ?? this.state.coreVersion,
						                 langVersion: msg.langVersion ?? this.state.langVersion,
						                 activeLang: msg.activeLang ?? this.activeLang,
						                 i18nAttached: msg.i18nAttached ?? this.state.i18nAttached,
						                 source: msg.source ?? this.state.source,
						                 error: null
					                 });
					return;
				}

				if (msg.type === 'RPC_RESPONSE') {
					const pending = this.pendingRequests.get(msg.reqId);
					if (pending) {
						this.pendingRequests.delete(msg.reqId);
						if (msg.ok) {
							pending.resolve(msg.result);
						} else {
							pending.reject(new Error(msg.error));
						}
					}
				}
			};

			this.worker.onerror = (err) => {
				this.updateState({status: 'error', error: err.message || 'Errore nel DB Worker'});
			};

			window.addEventListener('online', () => {
				this.syncWithRemoteManifest().catch(() => {});
			});
		}

		this.syncWithRemoteManifest();
	}

	syncWithRemoteManifest() {
		const manifestUrl = new URL(APP_CONFIG.DB.MANIFEST_URL, window.location.href).href;
		return this.callWorker('INIT', {
			...APP_CONFIG.DB,
			MANIFEST_URL: manifestUrl,
			lang: this.activeLang
		}).catch((err) => {
			this.updateState({status: 'error', error: err.message});
		});
	}

	/**
	 * Permette all'utente di passare in tempo reale da Italiano a Inglese (o altre lingue future).
	 */
	async setLanguage(newLang) {
		if (newLang === this.activeLang && this.isReady()) return;
		this.activeLang = newLang;
		this.entityCache.clear();
		await this.syncWithRemoteManifest();
	}

	onStatusChange(callback) {
		this.statusListeners.add(callback);
		callback(this.state);
		return () => this.statusListeners.delete(callback);
	}

	updateState(patch) {
		this.state = {...this.state, ...patch};
		for (const cb of this.statusListeners) {
			cb(this.state);
		}
	}

	isReady() {
		return this.state.status === 'ready' || Boolean(this.state.coreVersion);
	}

	callWorker(action, payload = {}) {
		if (!this.worker) this.init();
		const reqId = ++this.reqCounter;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(reqId, {resolve, reject});
			this.worker.postMessage({reqId, action, payload});
		});
	}

	// --- RECUPERO RECORD PER ID IMMUTABILE ---

	async getById(table, id) {
		if (id === undefined || id === null) return null;
		const cacheKey = `${this.activeLang}:${table}:${id}`;
		if (this.entityCache.has(cacheKey)) {
			return this.entityCache.get(cacheKey);
		}
		const record = await this.callWorker('GET_BY_ID', {table, id});
		if (record) {
			this.entityCache.set(cacheKey, record);
		}
		return record;
	}

	/**
	 * Risolve un'entità durante l'importazione (es. da Fight Club 5e XML)
	 * e restituisce il record completo del DB con il suo `id` immutabile.
	 */
	async resolveEntity(lookup) {
		if (!lookup || !lookup.table) return null;
		if (lookup.id !== undefined && lookup.id !== null) {
			return this.getById(lookup.table, lookup.id);
		}
		const record = await this.callWorker('RESOLVE_ENTITY', lookup);
		if (record) {
			this.entityCache.set(`${this.activeLang}:${lookup.table}:${record.id}`, record);
		}
		return record;
	}

	async resolveBatch(items) {
		return this.callWorker('RESOLVE_BATCH', {items});
	}

	/**
	 * Unisce i dati salvati nella scheda del PG (che usa `dbId` e snapshot meccanico)
	 * con i testi localizzati (ITA/ENG) letti dal DB SQLite.
	 * Se l'elemento è `isCustom: true`, usa direttamente i dati custom della scheda o della campagna.
	 */
	async hydrateEntry(table, entry, campaignCustomRegistry = null) {
		if (!entry) return null;

		if (entry.isCustom) {
			if (entry.customId && campaignCustomRegistry && campaignCustomRegistry[entry.customId]) {
				return {...campaignCustomRegistry[entry.customId], ...entry};
			}
			return entry;
		}

		const targetId = entry.dbId ?? entry.id;
		if (targetId === undefined || targetId === null || !this.isReady()) {
			return entry;
		}

		try {
			const dbRecord = await this.getById(table, targetId);
			if (!dbRecord) return entry;

			return {
				...dbRecord,
				...entry,
				name: dbRecord.name || entry.name,
				name_eng: dbRecord.name_eng || entry.name,
				description: dbRecord.description || entry.text || entry.description || '',
				dbRecord
			};
		} catch (_) {
			return entry;
		}
	}

	// --- QUERY SPECIALIZZATE E RICERCA FTS4 ---

	async search(queryText, category = null, limit = 35) {
		return this.callWorker('SEARCH', {queryText, category, limit});
	}

	async getConditions() {
		return this.callWorker('QUERY_TABLE', {
			table: 'conditions',
			orderBy: 'name ASC',
			limit: 50
		});
	}

	async getSources() {
		return this.callWorker('QUERY_TABLE', {
			table: 'sources',
			orderBy: 'c.is_core DESC, name ASC',
			limit: 200
		});
	}

	async getSpellsByClass(classNameEng, maxLevel = 9) {
		return this.callWorker('QUERY_TABLE', {
			table: 'spells',
			whereClause: 'c.classes LIKE ? AND c.level <= ?',
			params: [`%${classNameEng}%`, maxLevel],
			orderBy: 'c.level ASC, name ASC',
			limit: 500
		});
	}

	async getItemsForShop({rarity = null, type = null, search = null, limit = 100} = {}) {
		const clauses = [];
		const params = [];
		if (rarity) {
			clauses.push('LOWER(c.rarity) = LOWER(?)');
			params.push(rarity);
		}
		if (type) {
			clauses.push('LOWER(c.type) LIKE LOWER(?)');
			params.push(`%${type}%`);
		}
		if (search) {
			clauses.push('(c.name LIKE ? OR i.name LIKE ?)');
			params.push(`%${search}%`, `%${search}%`);
		}
		return this.callWorker('QUERY_TABLE', {
			table: 'items',
			whereClause: clauses.join(' AND '),
			params,
			orderBy: 'name ASC',
			limit
		});
	}
}

export const dbService = new CompendiumDbService();