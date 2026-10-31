// js/db-worker.js

let SQL = null;
let coreDb = null;
let langDb = null;
let i18nAttached = false;
let activeLang = 'ita';
let coreVersion = null;
let langVersion = null;
const selectQueryCache = new Map();

const ALLOWED_TABLES = new Set([
	                               'sources', 'spells', 'feats', 'races', 'classes', 'subclasses',
	                               'class_features', 'backgrounds', 'items', 'monsters', 'languages',
	                               'deities', 'rules', 'conditions', 'actions', 'variants', 'hazards'
                               ]);

// --- GESTIONE CACHE INDEXEDDB ---

function openCacheDB(idbName, storeName) {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(idbName, 1);
		req.onupgradeneeded = (e) => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function readPackFromCache(idbName, storeName, key) {
	const db = await openCacheDB(idbName, storeName);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, 'readonly');
		const req = tx.objectStore(storeName).get(key);
		req.onsuccess = () => resolve(req.result || null);
		req.onerror = () => reject(req.error);
	});
}

async function writePackToCache(idbName, storeName, key, value) {
	const db = await openCacheDB(idbName, storeName);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, 'readwrite');
		tx.objectStore(storeName).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// --- CARICAMENTO SQL.JS E DECOMPRESSIONE GZIP ---

async function ensureSqlJsLoaded(wasmCdnUrl) {
	if (SQL) return SQL;
	importScripts(`${wasmCdnUrl}sql-wasm.js`);
	SQL = await initSqlJs({
		                      locateFile: (file) => `${wasmCdnUrl}${file}`
	                      });
	return SQL;
}

async function decompressGzipIfNeeded(uint8Array) {
	// Verifica magic bytes Gzip (0x1f, 0x8b)
	if (uint8Array.length >= 2 && uint8Array[0] === 0x1f && uint8Array[1] === 0x8b) {
		if (typeof DecompressionStream === 'undefined') {
			throw new Error('Il browser non supporta DecompressionStream per file .gz');
		}
		const stream = new Blob([uint8Array]).stream().pipeThrough(new DecompressionStream('gzip'));
		const buffer = await new Response(stream).arrayBuffer();
		return new Uint8Array(buffer);
	}
	return uint8Array;
}

async function downloadPackWithProgress(url, packLabel) {
	const response = await fetch(url, {cache: 'no-cache'});
	if (!response.ok) {
		throw new Error(`Download ${packLabel} fallito (${response.status})`);
	}

	const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
	const reader = response.body.getReader();
	const chunks = [];
	let receivedLength = 0;
	let lastPct = -1;

	while (true) {
		const {done, value} = await reader.read();
		if (done) break;
		chunks.push(value);
		receivedLength += value.length;

		if (contentLength > 0) {
			const pct = Math.min(100, Math.round((receivedLength / contentLength) * 100));
			if (pct !== lastPct) {
				lastPct = pct;
				self.postMessage({
					                 type: 'DB_STATUS',
					                 status: 'downloading',
					                 pack: packLabel,
					                 progress: pct,
					                 loadedBytes: receivedLength,
					                 totalBytes: contentLength
				                 });
			}
		} else {
			self.postMessage({
				                 type: 'DB_STATUS',
				                 status: 'downloading',
				                 pack: packLabel,
				                 progress: null,
				                 loadedBytes: receivedLength,
				                 totalBytes: 0
			                 });
		}
	}

	const rawBuffer = new Uint8Array(receivedLength);
	let pos = 0;
	for (const chunk of chunks) {
		rawBuffer.set(chunk, pos);
		pos += chunk.length;
	}

	self.postMessage({type: 'DB_STATUS', status: 'decompressing', pack: packLabel});
	return await decompressGzipIfNeeded(rawBuffer);
}

// --- MONTAGGIO DATABASE CORE + ATTACH LANGUAGE PACK ---

function closeMountedDatabases() {
	selectQueryCache.clear();
	if (coreDb) {
		if (i18nAttached) {
			try { coreDb.run('DETACH DATABASE i18n;'); } catch (_) {}
			i18nAttached = false;
		}
		try { coreDb.close(); } catch (_) {}
		coreDb = null;
	}
	if (langDb) {
		try { langDb.close(); } catch (_) {}
		langDb = null;
	}
}

function mountDatabases(coreBuffer, langBuffer, cVer, lVer) {
	closeMountedDatabases();

	coreDb = new SQL.Database(coreBuffer);
	coreVersion = cVer;
	langVersion = lVer || null;

	if (langBuffer && activeLang !== 'eng') {
		langDb = new SQL.Database(langBuffer);
		try {
			coreDb.run(`ATTACH DATABASE '${langDb.filename}' AS i18n;`);
			i18nAttached = true;
		} catch (attachErr) {
			// Fallback con slash iniziale se richiesto dal path virtuale Emscripten
			try {
				coreDb.run(`ATTACH DATABASE '/${langDb.filename}' AS i18n;`);
				i18nAttached = true;
			} catch (err2) {
				console.warn('Impossibile eseguire ATTACH DATABASE i18n:', err2);
				i18nAttached = false;
			}
		}
	}
}

// --- INIZIALIZZAZIONE E AGGIORNAMENTO NON BLOCCANTE ---

async function initAndSyncDatabases(config) {
	const {MANIFEST_URL, IDB_NAME, IDB_STORE, SQLJS_WASM_CDN, lang} = config;
	if (lang) activeLang = lang;

	self.postMessage({type: 'DB_STATUS', status: 'initializing'});
	await ensureSqlJsLoaded(SQLJS_WASM_CDN);

	const langKey = activeLang !== 'eng' ? `lang_${activeLang}` : null;

	// 1. Montaggio istantaneo dalla cache IndexedDB (per operatività immediata anche offline)
	let cachedCore = await readPackFromCache(IDB_NAME, IDB_STORE, 'core');
	let cachedLang = langKey ? await readPackFromCache(IDB_NAME, IDB_STORE, langKey) : null;

	if (cachedCore && cachedCore.buffer) {
		mountDatabases(
			cachedCore.buffer,
			cachedLang ? cachedLang.buffer : null,
			cachedCore.version,
			cachedLang ? cachedLang.version : null
		);
		self.postMessage({
			                 type: 'DB_STATUS',
			                 status: 'ready',
			                 source: 'cache',
			                 coreVersion,
			                 langVersion,
			                 activeLang,
			                 i18nAttached
		                 });
	}

	// 2. Controllo aggiornamenti in background se online
	if (navigator.onLine) {
		try {
			const manifestRes = await fetch(MANIFEST_URL, {cache: 'no-store'});
			if (manifestRes.ok) {
				const manifest = await manifestRes.json();
				let updated = false;

				// Verifica aggiornamento DB Core
				const remoteCore = manifest.core;
				if (remoteCore && (!cachedCore || cachedCore.version !== remoteCore.version)) {
					const coreUrl = new URL(remoteCore.file, MANIFEST_URL).href;
					const freshCoreBuf = await downloadPackWithProgress(coreUrl, 'Compendio Core (ENG)');
					cachedCore = {version: remoteCore.version, buffer: freshCoreBuf, updatedAt: Date.now()};
					await writePackToCache(IDB_NAME, IDB_STORE, 'core', cachedCore);
					updated = true;
				}

				// Verifica aggiornamento DB Lingua (es. ita)
				const remoteLang = langKey && manifest.languages ? manifest.languages[activeLang] : null;
				if (remoteLang && (!cachedLang || cachedLang.version !== remoteLang.version)) {
					const langUrl = new URL(remoteLang.file, MANIFEST_URL).href;
					const freshLangBuf = await downloadPackWithProgress(langUrl, `Traduzione (${remoteLang.label || activeLang.toUpperCase()})`);
					cachedLang = {version: remoteLang.version, buffer: freshLangBuf, updatedAt: Date.now()};
					await writePackToCache(IDB_NAME, IDB_STORE, langKey, cachedLang);
					updated = true;
				}

				if (updated && cachedCore && cachedCore.buffer) {
					mountDatabases(
						cachedCore.buffer,
						cachedLang ? cachedLang.buffer : null,
						cachedCore.version,
						cachedLang ? cachedLang.version : null
					);
					self.postMessage({
						                 type: 'DB_STATUS',
						                 status: 'ready',
						                 source: 'network',
						                 coreVersion,
						                 langVersion,
						                 activeLang,
						                 i18nAttached
					                 });
				}
			}
		} catch (netErr) {
			if (!coreDb) {
				throw new Error('Download database fallito e nessuna copia locale presente: ' + netErr.message);
			}
		}
	} else if (!coreDb) {
		throw new Error('Dispositivo offline e database non ancora presente nella cache del browser.');
	}

	return {coreVersion, langVersion, activeLang, i18nAttached};
}

// --- GENERATORE AUTOMATICO DI QUERY BILINGUI CON COALESCE ---

function execStmtOn(db, sql, params = []) {
	if (!db) throw new Error('Database SQLite non inizializzato.');
	const stmt = db.prepare(sql);
	stmt.bind(params);
	const rows = [];
	while (stmt.step()) {
		rows.push(stmt.getAsObject());
	}
	stmt.free();
	return rows;
}

function getLocalizedTableSelectSql(table) {
	if (!ALLOWED_TABLES.has(table)) {
		throw new Error(`Tabella non consentita: ${table}`);
	}
	const cacheKey = `${table}:${activeLang}:${i18nAttached}`;
	if (selectQueryCache.has(cacheKey)) {
		return selectQueryCache.get(cacheKey);
	}

	const coreCols = execStmtOn(coreDb, `PRAGMA main.table_info("${table}")`).map(r => r.name);

	if (!i18nAttached || activeLang === 'eng') {
		const sql = `SELECT c.*, c.name AS name_eng, NULL AS name_ita FROM main."${table}" c`;
		selectQueryCache.set(cacheKey, sql);
		return sql;
	}

	const i18nCols = new Set(
		execStmtOn(coreDb, `PRAGMA i18n.table_info("${table}")`).map(r => r.name)
	);

	if (i18nCols.size === 0) {
		const sql = `SELECT c.*, c.name AS name_eng, NULL AS name_ita FROM main."${table}" c`;
		selectQueryCache.set(cacheKey, sql);
		return sql;
	}

	const selectParts = coreCols.map((col) => {
		if (col === 'id') return `c.id AS id`;
		if (col === 'name' && i18nCols.has('name')) {
			return `c.name AS name_eng, i.name AS name_ita, COALESCE(i.name, c.name) AS name`;
		}
		if (i18nCols.has(col)) {
			return `COALESCE(i."${col}", c."${col}") AS "${col}"`;
		}
		return `c."${col}" AS "${col}"`;
	});

	const sql = `SELECT ${selectParts.join(', ')}
		             FROM main."${table}"        c
			             LEFT JOIN i18n."${table}" i ON i.id = c.id`;
	selectQueryCache.set(cacheKey, sql);
	return sql;
}

// --- RISOLUZIONE ENTITÀ PER ID O PER CHIAVE NATURALE (IMPORTER) ---

function getById({table, id}) {
	if (id === undefined || id === null) return null;
	const baseSql = getLocalizedTableSelectSql(table);
	const rows = execStmtOn(coreDb, `${baseSql} WHERE c.id = ? LIMIT 1`, [id]);
	return rows[0] || null;
}

function resolveEntity({table, id, name, source, class_name, subclass_name, level}) {
	if (!ALLOWED_TABLES.has(table)) {
		throw new Error(`Tabella non valida: ${table}`);
	}

	// 1. Ricerca diretta per ID immutabile (usata dalle schede salvate)
	if (id !== undefined && id !== null) {
		const foundById = getById({table, id});
		if (foundById) return foundById;
	}

	// 2. Ricerca per nome (inglese o tradotto) usata dagli importer (es. Fight Club 5e XML)
	if (!name) return null;
	const cleanName = name.trim();
	const baseSql = getLocalizedTableSelectSql(table);

	// Costruisce filtri opzionali specifici per class_features o subclasses
	const extraClauses = [];
	const extraParams = [];

	if (source) {
		extraClauses.push(`LOWER(c.source) = LOWER(?)`);
		extraParams.push(source.trim());
	}
	if (class_name && (table === 'subclasses' || table === 'class_features')) {
		extraClauses.push(`LOWER(c.class_name) = LOWER(?)`);
		extraParams.push(class_name.trim());
	}
	if (level !== undefined && level !== null && table === 'class_features') {
		extraClauses.push(`c.level <= ?`);
		extraParams.push(level);
	}

	const extraWhere = extraClauses.length > 0 ? ` AND ${extraClauses.join(' AND ')}` : '';

	// Cerca prima nel nome inglese del DB Core
	const byEng = execStmtOn(
		coreDb,
		`${baseSql} WHERE LOWER(c.name) = LOWER(?)${extraWhere} ORDER BY c.id ASC LIMIT 1`,
		[cleanName, ...extraParams]
	);
	if (byEng.length > 0) return byEng[0];

	// Se non trovato con source restrittivo, riprova senza filtro source (Fight Club spesso non specifica il manuale)
	if (source) {
		const byEngNoSource = execStmtOn(
			coreDb,
			`${baseSql} WHERE LOWER(c.name) = LOWER(?) ORDER BY c.id ASC LIMIT 1`,
			[cleanName]
		);
		if (byEngNoSource.length > 0) return byEngNoSource[0];
	}

	// Se è montato il DB di traduzione, cerca anche nel nome tradotto (es. XML in italiano)
	if (i18nAttached) {
		const byTranslated = execStmtOn(
			coreDb,
			`${baseSql} WHERE LOWER(i.name) = LOWER(?) ORDER BY c.id ASC LIMIT 1`,
			[cleanName]
		);
		if (byTranslated.length > 0) return byTranslated[0];
	}

	return null;
}

// --- RICERCA FULL-TEXT FTS4 BILINGUE ---

function searchCompendium({queryText, category = null, limit = 35}) {
	const clean = (queryText || '').trim();
	if (!clean) return [];

	const ftsQuery = clean
		.replace(/['"*()-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.map(term => `${term}*`)
		.join(' ');

	if (!ftsQuery) return [];

	const mergedMap = new Map();

	const runFtsOn = (db, isTranslatedDb) => {
		if (!db) return;
		try {
			const sql = category
			            ? `SELECT category, entity_id, name, source, details, content
				               FROM fts_search
				               WHERE fts_search MATCH ?
						             AND LOWER(category) = LOWER(?) LIMIT ?`
			            : `SELECT category, entity_id, name, source, details, content
				               FROM fts_search
				               WHERE fts_search MATCH ? LIMIT ?`;
			const params = category ? [ftsQuery, category, limit] : [ftsQuery, limit];
			const rows = execStmtOn(db, sql, params);

			for (const r of rows) {
				const key = `${r.category}:${r.entity_id}`;
				if (!mergedMap.has(key)) {
					mergedMap.set(key, {
						category: r.category,
						id: Number(r.entity_id) || r.entity_id,
						name: r.name,
						source: r.source,
						details: r.details,
						content: r.content,
						matchedLang: isTranslatedDb ? activeLang : 'eng'
					});
				}
			}
		} catch (_) {}
	};

	// 1. Cerca prima nella tabella FTS4 della lingua attiva (es. Italiano)
	if (langDb && activeLang !== 'eng') {
		runFtsOn(langDb, true);
	}
	// 2. Cerca anche nella tabella FTS4 Inglese (Core) per coprire termini non ancora tradotti
	runFtsOn(coreDb, false);

	return Array.from(mergedMap.values()).slice(0, limit);
}

// --- QUERY FILTRATE PER TABELLA (USANDO LE VISTE COALESCE) ---

function queryTable({table, whereClause = '', params = [], orderBy = 'name ASC', limit = 200}) {
	const baseSql = getLocalizedTableSelectSql(table);
	const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
	const orderSql = orderBy ? ` ORDER BY ${orderBy}` : '';
	const limitSql = limit ? ` LIMIT ${Number(limit)}` : '';
	return execStmtOn(coreDb, `${baseSql}${whereSql}${orderSql}${limitSql}`, params);
}

// --- DISPATCHER RPC ---

self.onmessage = async (event) => {
	const {reqId, action, payload} = event.data || {};
	try {
		let result = null;

		switch (action) {
			case 'INIT':
				result = await initAndSyncDatabases(payload);
				break;
			case 'GET_BY_ID':
				result = getById(payload);
				break;
			case 'RESOLVE_ENTITY':
				result = resolveEntity(payload);
				break;
			case 'RESOLVE_BATCH':
				result = (payload.items || []).map(item => resolveEntity(item));
				break;
			case 'QUERY_TABLE':
				result = queryTable(payload);
				break;
			case 'RAW_QUERY':
				result = execStmtOn(coreDb, payload.sql, payload.params || []);
				break;
			case 'SEARCH':
				result = searchCompendium(payload);
				break;
			default:
				throw new Error(`Azione worker sconosciuta: ${action}`);
		}

		self.postMessage({type: 'RPC_RESPONSE', reqId, ok: true, result});
	} catch (err) {
		self.postMessage({type: 'RPC_RESPONSE', reqId, ok: false, error: err.message});
	}
};