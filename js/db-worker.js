// js/db-worker.js

let SQL = null;
let coreDb = null;
let langDb = null;
let i18nAttached = false;
let activeLang = 'eng';
let coreVersion = null;
let langVersion = null;
const selectQueryCache = new Map();

const ALLOWED_TABLES = new Set([
	                               'sources', 'spells', 'feats', 'races', 'classes', 'subclasses',
	                               'class_features', 'backgrounds', 'items', 'monsters', 'languages',
	                               'deities', 'rules', 'conditions', 'actions', 'variants', 'hazards'
                               ]);

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

async function ensureSqlJsLoaded(wasmCdnUrl) {
	if (SQL) return SQL;
	importScripts(`${wasmCdnUrl}sql-wasm.js`);
	SQL = await initSqlJs({
		                      locateFile: (file) => `${wasmCdnUrl}${file}`
	                      });
	return SQL;
}

async function decompressGzipIfNeeded(uint8Array) {
	if (uint8Array.length >= 2 && uint8Array[0] === 0x1f && uint8Array[1] === 0x8b) {
		if (typeof DecompressionStream === 'undefined') {
			throw new Error('DecompressionStream not supported by browser.');
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
		throw new Error(`Failed to download ${packLabel} (${response.status})`);
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
		} catch (_) {
			try {
				coreDb.run(`ATTACH DATABASE '/${langDb.filename}' AS i18n;`);
				i18nAttached = true;
			} catch (err2) {
				console.warn('ATTACH DATABASE i18n failed:', err2);
				i18nAttached = false;
			}
		}
	}
}

/**
 * Risolve in modo universale il path del file .sqlite.gz rispetto a db-manifest.json
 * funzionando sia se nel JSON c'è "./data/file.sqlite.gz" sia se c'è "./file.sqlite.gz".
 */
function resolveAssetUrl(filePath, manifestUrl) {
	const clean = String(filePath || '')
		.trim()
		.replace(/^\.\//, '')
		.replace(/^data\//, '');
	return new URL(clean, manifestUrl).href;
}

async function initAndSyncDatabases(config) {
	const {MANIFEST_URL, IDB_NAME, IDB_STORE, SQLJS_WASM_CDN, lang} = config;
	if (lang) activeLang = lang;

	self.postMessage({type: 'DB_STATUS', status: 'initializing', activeLang});
	await ensureSqlJsLoaded(SQLJS_WASM_CDN);

	const langKey = activeLang !== 'eng' ? `lang_${activeLang}` : null;

	let cachedCore = await readPackFromCache(IDB_NAME, IDB_STORE, 'core');
	let cachedLang = langKey ? await readPackFromCache(IDB_NAME, IDB_STORE, langKey) : null;

	const needsRemoteLangDownload = Boolean(langKey && !cachedLang && navigator.onLine);

	if (cachedCore && cachedCore.buffer) {
		mountDatabases(
			cachedCore.buffer,
			cachedLang ? cachedLang.buffer : null,
			cachedCore.version,
			cachedLang ? cachedLang.version : null
		);

		if (!needsRemoteLangDownload) {
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
	}

	if (navigator.onLine) {
		try {
			const manifestRes = await fetch(MANIFEST_URL, {cache: 'no-store'});
			if (manifestRes.ok) {
				const manifest = await manifestRes.json();
				let updated = false;

				// 1. Scarica o aggiorna sempre il DB Core (ENG)
				const remoteCore = manifest.core;
				if (remoteCore && (!cachedCore || cachedCore.version !== remoteCore.version)) {
					const coreUrl = resolveAssetUrl(remoteCore.file, MANIFEST_URL);
					const freshCoreBuf = await downloadPackWithProgress(coreUrl, 'Core DB (ENG)');
					cachedCore = {version: remoteCore.version, buffer: freshCoreBuf, updatedAt: Date.now()};
					await writePackToCache(IDB_NAME, IDB_STORE, 'core', cachedCore);
					updated = true;
				}

				// 2. Scarica il DB di traduzione SOLO se activeLang !== "eng"
				const remoteLang = langKey && manifest.languages ? manifest.languages[activeLang] : null;
				if (remoteLang && (!cachedLang || cachedLang.version !== remoteLang.version)) {
					const langUrl = resolveAssetUrl(remoteLang.file, MANIFEST_URL);
					const freshLangBuf = await downloadPackWithProgress(
						langUrl,
						`DB ${remoteLang.label || activeLang.toUpperCase()}`
					);
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
				throw new Error('Failed to download DB and no offline copy available: ' + netErr.message);
			}
		}
	} else if (!coreDb) {
		throw new Error('Offline and database not cached yet.');
	}

	return {coreVersion, langVersion, activeLang, i18nAttached};
}

function execStmtOn(db, sql, params = []) {
	if (!db) throw new Error('SQLite Database not initialized.');
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
		throw new Error(`Invalid table: ${table}`);
	}
	const cacheKey = `${table}:${activeLang}:${i18nAttached}`;
	if (selectQueryCache.has(cacheKey)) {
		return selectQueryCache.get(cacheKey);
	}

	const coreCols = execStmtOn(coreDb, `PRAGMA main.table_info("${table}")`).map((r) => r.name);

	if (!i18nAttached || activeLang === 'eng') {
		const sql = `SELECT c.*, c.name AS name_eng, NULL AS name_ita FROM main."${table}" c`;
		selectQueryCache.set(cacheKey, sql);
		return sql;
	}

	const i18nCols = new Set(
		execStmtOn(coreDb, `PRAGMA i18n.table_info("${table}")`).map((r) => r.name)
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

function getById({table, id}) {
	if (id === undefined || id === null) return null;
	const baseSql = getLocalizedTableSelectSql(table);
	const rows = execStmtOn(coreDb, `${baseSql} WHERE c.id = ? LIMIT 1`, [id]);
	return rows[0] || null;
}

function resolveEntity({table, id, name, source, class_name, level}) {
	if (!ALLOWED_TABLES.has(table)) {
		throw new Error(`Invalid table: ${table}`);
	}

	if (id !== undefined && id !== null) {
		const foundById = getById({table, id});
		if (foundById) return foundById;
	}

	if (!name) return null;
	const cleanName = name.trim();
	const baseSql = getLocalizedTableSelectSql(table);

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

	const byEng = execStmtOn(
		coreDb,
		`${baseSql} WHERE LOWER(c.name) = LOWER(?)${extraWhere} ORDER BY c.id ASC LIMIT 1`,
		[cleanName, ...extraParams]
	);
	if (byEng.length > 0) return byEng[0];

	if (source) {
		const byEngNoSource = execStmtOn(
			coreDb,
			`${baseSql} WHERE LOWER(c.name) = LOWER(?) ORDER BY c.id ASC LIMIT 1`,
			[cleanName]
		);
		if (byEngNoSource.length > 0) return byEngNoSource[0];
	}

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

function searchCompendium({queryText, category = null, limit = 35}) {
	const clean = (queryText || '').trim();
	if (!clean) return [];

	const ftsQuery = clean
		.replace(/['"*()-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `${term}*`)
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

	if (langDb && activeLang !== 'eng') {
		runFtsOn(langDb, true);
	}
	runFtsOn(coreDb, false);

	return Array.from(mergedMap.values()).slice(0, limit);
}

function queryTable({table, whereClause = '', params = [], orderBy = 'name ASC', limit = 200}) {
	const baseSql = getLocalizedTableSelectSql(table);
	const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
	const orderSql = orderBy ? ` ORDER BY ${orderBy}` : '';
	const limitSql = limit ? ` LIMIT ${Number(limit)}` : '';
	return execStmtOn(coreDb, `${baseSql}${whereSql}${orderSql}${limitSql}`, params);
}

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
				result = (payload.items || []).map((item) => resolveEntity(item));
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
				throw new Error(`Unknown worker action: ${action}`);
		}

		self.postMessage({type: 'RPC_RESPONSE', reqId, ok: true, result});
	} catch (err) {
		self.postMessage({type: 'RPC_RESPONSE', reqId, ok: false, error: err.message});
	}
};