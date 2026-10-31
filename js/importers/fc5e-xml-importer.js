// js/importers/fc5e-xml-importer.js
import {dbService} from '../db-service.js';

export class FightClub5eXmlImporter {
	async parseXmlString(xmlString) {
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

		const parseError = xmlDoc.querySelector('parsererror');
		if (parseError) {
			throw new Error('File XML non valido o corrotto: ' + parseError.textContent);
		}

		const pcNode = xmlDoc.querySelector('player');
		if (!pcNode) {
			throw new Error('Formato XML non riconosciuto: tag <player> non trovato (Verifica che sia un export valido di Fight Club 5e).');
		}

		const getText = (parent, selector, fallback = '') => {
			const el = parent.querySelector(selector);
			return el ? el.textContent.trim() : fallback;
		};

		const getNumber = (parent, selector, fallback = 0) => {
			const val = getText(parent, selector);
			const num = Number(val);
			return isNaN(num) ? fallback : num;
		};

		// 1. Estrazione dati anagrafici e attributi base
		const character = {
			name: getText(pcNode, 'name', 'Eroe Senza Nome'),
			level: getNumber(pcNode, 'level', 1),
			experience: getNumber(pcNode, 'exp', 0),
			race: getText(pcNode, 'race'),
			background: getText(pcNode, 'background'),
			alignment: getText(pcNode, 'alignment'),
			classesRaw: getText(pcNode, 'classes'),
			inspiration: getText(pcNode, 'inspiration', 'false') === 'true',
			hp: {
				max: getNumber(pcNode, 'hp', 10),
				current: getNumber(pcNode, 'hp', 10),
				temp: 0
			},
			abilities: {
				str: getNumber(pcNode, 'strength', 10),
				dex: getNumber(pcNode, 'dexterity', 10),
				con: getNumber(pcNode, 'constitution', 10),
				int: getNumber(pcNode, 'intelligence', 10),
				wis: getNumber(pcNode, 'wisdom', 10),
				cha: getNumber(pcNode, 'charisma', 10)
			},
			skills: getText(pcNode, 'skills'),
			money: {
				cp: getNumber(pcNode, 'cp', 0),
				sp: getNumber(pcNode, 'sp', 0),
				ep: getNumber(pcNode, 'ep', 0),
				gp: getNumber(pcNode, 'gp', 0),
				pp: getNumber(pcNode, 'pp', 0)
			},
			spells: [],
			items: [],
			feats: [],
			features: [],
			companions: [],
			notes: getText(pcNode, 'notes')
		};

		// 2. Estrazione Incantesimi
		const spellNodes = pcNode.querySelectorAll('spell');
		const rawSpells = [];
		spellNodes.forEach(node => {
			rawSpells.push({
				               table: 'spells',
				               name: getText(node, 'name'),
				               source: getText(node, 'source', 'PHB'),
				               text: getText(node, 'text'),
				               prepared: getText(node, 'prepared', 'true') === 'true',
				               level: getNumber(node, 'level', 0)
			               });
		});

		// 3. Estrazione Oggetti ed Equipaggiamento
		const itemNodes = pcNode.querySelectorAll('item');
		const rawItems = [];
		itemNodes.forEach(node => {
			rawItems.push({
				              table: 'items',
				              name: getText(node, 'name'),
				              source: getText(node, 'source', 'PHB'),
				              count: getNumber(node, 'count', 1),
				              equipped: getText(node, 'equipped', 'false') === 'true',
				              text: getText(node, 'text'),
				              weight: getNumber(node, 'weight', 0),
				              cost: getText(node, 'cost')
			              });
		});

		// 4. Estrazione Talenti e Privilegi (Feats / Features)
		const featNodes = pcNode.querySelectorAll('feat');
		const rawFeats = [];
		featNodes.forEach(node => {
			rawFeats.push({
				              table: 'feats',
				              name: getText(node, 'name'),
				              source: getText(node, 'source', 'PHB'),
				              text: getText(node, 'text')
			              });
		});

		// 5. Risoluzione Batch degli ID immutabili tramite dbService
		if (dbService.isReady()) {
			try {
				const resolvedSpells = await dbService.resolveBatch(rawSpells);
				character.spells = rawSpells.map((raw, idx) => {
					const res = resolvedSpells[idx];
					if (res) {
						return {dbId: res.id, isCustom: false, prepared: raw.prepared, customData: null};
					}
					return {dbId: null, isCustom: true, prepared: raw.prepared, customData: raw};
				});

				const resolvedItems = await dbService.resolveBatch(rawItems);
				character.items = rawItems.map((raw, idx) => {
					const res = resolvedItems[idx];
					if (res) {
						return {dbId: res.id, isCustom: false, count: raw.count, equipped: raw.equipped, customData: null};
					}
					return {dbId: null, isCustom: true, count: raw.count, equipped: raw.equipped, customData: raw};
				});

				const resolvedFeats = await dbService.resolveBatch(rawFeats);
				character.feats = rawFeats.map((raw, idx) => {
					const res = resolvedFeats[idx];
					if (res) {
						return {dbId: res.id, isCustom: false, customData: null};
					}
					return {dbId: null, isCustom: true, customData: raw};
				});
			} catch (e) {
				console.warn('Risoluzione batch DB non riuscita, fallback su elementi custom:', e);
				character.spells = rawSpells.map(r => ({dbId: null, isCustom: true, prepared: r.prepared, customData: r}));
				character.items = rawItems.map(r => ({dbId: null, isCustom: true, count: r.count, equipped: r.equipped, customData: r}));
				character.feats = rawFeats.map(r => ({dbId: null, isCustom: true, customData: r}));
			}
		} else {
			// Se il DB SQLite non è ancora pronto all'avvio, salva tutto come custom temporaneo che verrà id-allineato appena il DB carica
			character.spells = rawSpells.map(r => ({dbId: null, isCustom: true, prepared: r.prepared, customData: r}));
			character.items = rawItems.map(r => ({dbId: null, isCustom: true, count: r.count, equipped: r.equipped, customData: r}));
			character.feats = rawFeats.map(r => ({dbId: null, isCustom: true, customData: r}));
		}

		return character;
	}
}

export const fc5eImporter = new FightClub5eXmlImporter();