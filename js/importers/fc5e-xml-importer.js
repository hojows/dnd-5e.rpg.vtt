// js/importers/fc5e-xml-importer.js
import {dbService} from '../db-service.js';
import {CORE_ABILITIES, CORE_SKILLS, getAbilityModifier} from '../formula-engine.js';
import {i18nService} from '../i18n-service.js';

const HD_FACES_MAP = {1: 6, 2: 8, 3: 10, 4: 12};

const SPELL_SCHOOL_MAP = {
	1: 'Abjuration',
	2: 'Conjuration',
	3: 'Divination',
	4: 'Enchantment',
	5: 'Evocation',
	6: 'Illusion',
	7: 'Necromancy',
	8: 'Transmutation'
};

const ABILITY_INDEX_TO_KEY = {
	0: 'str',
	1: 'dex',
	2: 'con',
	3: 'int',
	4: 'wis',
	5: 'cha',
	6: 'cha'
};

export class FightClub5eXmlImporter {
	directChild(parent, tagName) {
		if (!parent) return null;
		for (const ch of parent.children) {
			if (ch.tagName.toLowerCase() === tagName.toLowerCase()) return ch;
		}
		return null;
	}

	directChildren(parent, tagName) {
		if (!parent) return [];
		const target = tagName.toLowerCase();
		const out = [];
		for (const ch of parent.children) {
			if (ch.tagName.toLowerCase() === target) out.push(ch);
		}
		return out;
	}

	getText(parent, tagName, fallback = '') {
		const el = this.directChild(parent, tagName);
		return el ? el.textContent.trim() : fallback;
	}

	getNumber(parent, tagName, fallback = 0) {
		const raw = this.getText(parent, tagName, '');
		if (raw === '') return fallback;
		const num = Number(raw);
		return Number.isNaN(num) ? fallback : num;
	}

	cleanNameForDbLookup(rawName) {
		if (!rawName) return '';
		let s = String(rawName).trim();

		const parenMatch = s.match(/\(([A-Za-z'\s/-]+)\)\s*$/);
		if (parenMatch && !/1st|2nd|3rd|Guardian|Infiltrator|Intelligence/i.test(parenMatch[1])) {
			return parenMatch[1].trim();
		}

		s = s.replace(/^\[[^\]]+\]\s*/g, '');
		s = s.replace(/\s*\[[^\]]+\].*$/g, '');
		s = s.replace(/\s*[¦|].*$/g, '');
		s = s.replace(/\s+DAL LIVELLO\s+\d+.*$/i, '');
		s = s.replace(/^[^\w\sÀ-ÿ'()-]+/g, '').trim();
		return s || rawName.trim();
	}

	extractSourceCode(textBlock) {
		if (!textBlock) return '';
		const m = String(textBlock).match(/Source:\s*([^\n\r,]+)/i);
		if (!m) return '';
		const src = m[1].trim();
		if (/Player's Handbook/i.test(src)) return 'PHB';
		if (/Tasha's Cauldron/i.test(src)) return 'TCE';
		if (/Xanathar's Guide/i.test(src)) return 'XGE';
		if (/Eberron/i.test(src)) return 'ERLW';
		if (/Strixhaven/i.test(src)) return 'SCC';
		if (/Fizban/i.test(src)) return 'FTD';
		if (/Spelljammer/i.test(src)) return 'AAG';
		if (/Mordenkainen Presents/i.test(src)) return 'MPMM';
		if (/Dungeon Master's Guide/i.test(src)) return 'DMG';
		return '';
	}

	parseModNodes(parentNode) {
		return this.directChildren(parentNode, 'mod').map((modEl) => ({
			name: this.getText(modEl, 'name', ''),
			category: this.getNumber(modEl, 'category', 0),
			type: this.getNumber(modEl, 'type', 0),
			value: this.getNumber(modEl, 'value', 0)
		}));
	}

	parseFeatNode(featEl, originLabel = '') {
		const text = this.getText(featEl, 'text', '');
		const rawName = this.getText(featEl, 'name', 'Feature');
		return {
			table: 'feats',
			name: rawName,
			lookupName: this.cleanNameForDbLookup(rawName),
			source: this.extractSourceCode(text),
			origin: originLabel,
			prerequisite: this.getText(featEl, 'prereq', ''),
			text,
			optional: this.getNumber(featEl, 'optional', 0) === 1,
			mods: this.parseModNodes(featEl)
		};
	}

	parseSpellNode(spellEl, originLabel = '', spellAbilityKey = 'int') {
		const rawName = this.getText(spellEl, 'name', 'Spell');
		const text = this.getText(spellEl, 'text', '');
		const schoolCode = this.getNumber(spellEl, 'school', 0);
		const v = this.getNumber(spellEl, 'v', 0) === 1;
		const s = this.getNumber(spellEl, 's', 0) === 1;
		const m = this.getNumber(spellEl, 'm', 0) === 1;
		const materials = this.getText(spellEl, 'materials', '');
		const compParts = [];
		if (v) compParts.push('V');
		if (s) compParts.push('S');
		if (m) compParts.push(materials ? `M (${materials})` : 'M');

		const rolls = this.directChildren(spellEl, 'roll').map((r) => r.textContent.trim()).filter(Boolean);
		const sclasses = this.directChildren(spellEl, 'sclass').map((c) => c.textContent.trim()).filter(Boolean);

		return {
			table: 'spells',
			name: rawName,
			lookupName: this.cleanNameForDbLookup(rawName),
			source: this.extractSourceCode(text),
			origin: originLabel,
			spellAbility: spellAbilityKey,
			level: this.getNumber(spellEl, 'level', 0),
			school: SPELL_SCHOOL_MAP[schoolCode] || '',
			ritual: this.getNumber(spellEl, 'ritual', 0) === 1,
			casting_time: this.getText(spellEl, 'time', ''),
			range_area: this.getText(spellEl, 'range', ''),
			components: compParts.join(', '),
			duration: this.getText(spellEl, 'duration', ''),
			prepared: this.getNumber(spellEl, 'prepared', 0) === 1,
			rolls,
			sclasses,
			text
		};
	}

	parseTrackerNode(trEl, originLabel = '') {
		const resetCode = this.getNumber(trEl, 'resetType', 2);
		return {
			label: this.getText(trEl, 'label', 'Resource'),
			origin: originLabel,
			type: this.getNumber(trEl, 'type', 0),
			resetType: resetCode,
			current: this.getNumber(trEl, 'value', 0),
			maxFormula: this.getText(trEl, 'formula', '0'),
			max: this.getNumber(trEl, 'formula', this.getNumber(trEl, 'value', 0))
		};
	}

	parseItemNode(itemEl, containerName = '') {
		const rawName = this.getText(itemEl, 'name', 'Item');
		const text = this.getText(itemEl, 'text', '');
		const slot = this.getNumber(itemEl, 'slot', 0);
		const typeCode = this.getNumber(itemEl, 'type', 0);
		const quantity = this.getNumber(itemEl, 'quantity', this.getNumber(itemEl, 'count', 1));
		const dmg1H = this.getText(itemEl, 'damage1H', '');
		const dmg2H = this.getText(itemEl, 'damage2H', '');
		const dmgTypeCode = this.getNumber(itemEl, 'damageType', 0);
		const dmgTypeLabel = dmgTypeCode ? i18nService.t(`damageTypes.${dmgTypeCode}`, '') : '';
		const imgEl = this.directChild(itemEl, 'imageData');

		let damageStr = '';
		if (dmg1H) {
			damageStr = `${dmg1H}${dmg2H ? ` (2H: ${dmg2H})` : ''}${dmgTypeLabel ? ` ${dmgTypeLabel}` : ''}`;
		}

		return {
			table: 'items',
			name: rawName,
			lookupName: this.cleanNameForDbLookup(rawName),
			source: this.extractSourceCode(text),
			container: containerName,
			detail: this.getText(itemEl, 'detail', ''),
			typeCode,
			slot,
			equipped: slot > 0 && typeCode !== 15,
			count: quantity,
			valueGp: this.getNumber(itemEl, 'value', 0),
			weight: this.getNumber(itemEl, 'weight', 0),
			ac: this.getNumber(itemEl, 'ac', 0),
			magic: this.getNumber(itemEl, 'magic', 0) === 1,
			damage: damageStr,
			damage1H: dmg1H,
			damage2H: dmg2H,
			damageTypeCode: dmgTypeCode,
			imageUid: imgEl ? this.getText(imgEl, 'uid', null) : null,
			mods: this.parseModNodes(itemEl),
			text
		};
	}

	parseMonsterNode(monsterEl) {
		const rawName = this.getText(monsterEl, 'name', 'Companion');
		const label = this.getText(monsterEl, 'label', rawName);
		const imgEl = this.directChild(monsterEl, 'imageData');
		const sizeCode = this.getNumber(monsterEl, 'size', 2);

		const abParts = this.getText(monsterEl, 'abilities', '10,10,10,10,10,10')
		                    .split(',')
		                    .map((s) => s.trim())
		                    .filter((s) => s !== '')
		                    .map(Number);

		const abilities = {
			str: abParts[0] ?? 10,
			dex: abParts[1] ?? 10,
			con: abParts[2] ?? 10,
			int: abParts[3] ?? 10,
			wis: abParts[4] ?? 10,
			cha: abParts[5] ?? 10
		};

		const savingThrows = this.directChildren(monsterEl, 'savingThrow').map((stEl) => {
			const abIdx = this.getNumber(stEl, 'ability', 0);
			const abInfo = CORE_ABILITIES[abIdx] || CORE_ABILITIES[0];
			const mod = this.getNumber(stEl, 'modifier', 0);
			return {abilityKey: abInfo.key, modifier: mod};
		});

		const skills = this.directChildren(monsterEl, 'skill').map((skEl) => {
			const skId = this.getNumber(skEl, 'id', 0);
			const skInfo = CORE_SKILLS.find((k) => k.monsterId === skId);
			const mod = this.getNumber(skEl, 'modifier', 0);
			return {skillKey: skInfo ? skInfo.key : `skill_${skId}`, modifier: mod};
		});

		const traits = this.directChildren(monsterEl, 'trait').map((el) => ({
			name: this.getText(el, 'name', ''),
			text: this.getText(el, 'text', '')
		}));

		const actions = this.directChildren(monsterEl, 'action').map((el) => {
			const attacks = this.directChildren(el, 'attack').map((atkEl) => ({
				name: this.getText(atkEl, 'name', ''),
				attackBonus: this.getText(atkEl, 'attackBonus', '0'),
				damage: this.getText(atkEl, 'damage', '')
			}));
			return {
				name: this.getText(el, 'name', ''),
				text: this.getText(el, 'text', ''),
				attacks
			};
		});

		const reactions = this.directChildren(monsterEl, 'reaction').map((el) => ({
			name: this.getText(el, 'name', ''),
			text: this.getText(el, 'text', '')
		}));

		return {
			table: 'monsters',
			label,
			name: rawName,
			lookupName: this.cleanNameForDbLookup(rawName),
			imageUid: imgEl ? this.getText(imgEl, 'uid', null) : null,
			sizeCode,
			type: this.getText(monsterEl, 'type', ''),
			alignment: this.getText(monsterEl, 'alignment', ''),
			ac: this.getText(monsterEl, 'ac', '10'),
			armor: this.getText(monsterEl, 'armor', ''),
			hd: this.getText(monsterEl, 'hd', ''),
			hp: {
				current: this.getNumber(monsterEl, 'hpCurrent', 10),
				max: this.getNumber(monsterEl, 'hpMax', 10)
			},
			speed: this.getText(monsterEl, 'speed', ''),
			abilities,
			savingThrows,
			skills,
			immune: this.getText(monsterEl, 'immune', ''),
			conditionImmune: this.getText(monsterEl, 'conditionImmune', ''),
			senses: this.getText(monsterEl, 'senses', ''),
			passivePerception: this.getNumber(monsterEl, 'passive', 10),
			languages: this.getText(monsterEl, 'languages', ''),
			text: this.getText(monsterEl, 'text', ''),
			traits,
			actions,
			reactions
		};
	}

	async parseXmlString(xmlString) {
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

		const parseError = xmlDoc.querySelector('parsererror');
		if (parseError) {
			throw new Error('Invalid XML: ' + parseError.textContent);
		}

		const pcRoot = xmlDoc.querySelector('pc') || xmlDoc.documentElement;
		const charNode =
			this.directChild(pcRoot, 'character') ||
			xmlDoc.querySelector('character') ||
			xmlDoc.querySelector('player');

		if (!charNode) {
			throw new Error('Unrecognized XML format: <character> node not found.');
		}

		const extractedImages = {};
		this.directChildren(pcRoot, 'imageData').forEach((imgNode) => {
			const uid = this.getText(imgNode, 'uid', '');
			const encoded = this.getText(imgNode, 'encoded', '').replace(/\s+/g, '');
			if (uid && encoded) {
				extractedImages[uid] = encoded;
			}
		});

		const charImgNode = this.directChild(charNode, 'imageData');
		const characterImageUid = charImgNode ? this.getText(charImgNode, 'uid', null) : null;

		const rawAbParts = this.getText(charNode, 'abilities', '10,10,10,10,10,10')
		                       .split(',')
		                       .map((s) => s.trim())
		                       .filter((s) => s !== '')
		                       .map(Number);

		const baseAbilities = {
			str: rawAbParts[0] ?? 10,
			dex: rawAbParts[1] ?? 10,
			con: rawAbParts[2] ?? 10,
			int: rawAbParts[3] ?? 10,
			wis: rawAbParts[4] ?? 10,
			cha: rawAbParts[5] ?? 10
		};

		const allMods = [...this.parseModNodes(charNode)];
		const proficiencyCodes = new Set();
		const rawSpells = [];
		const rawFeats = [];
		const trackers = [];

		const raceNode = this.directChild(charNode, 'race');
		let raceName = '';
		let raceDetails = {};
		if (raceNode) {
			raceName = this.getText(raceNode, 'name', '');
			raceDetails = {
				name: raceName,
				age: this.getText(raceNode, 'age', ''),
				height: this.getText(raceNode, 'height', ''),
				weight: this.getText(raceNode, 'weight', ''),
				eyes: this.getText(raceNode, 'eyes', ''),
				skin: this.getText(raceNode, 'skin', ''),
				hair: this.getText(raceNode, 'hair', '')
			};

			allMods.push(...this.parseModNodes(raceNode));
			this.directChildren(raceNode, 'proficiency').forEach((p) =>
				                                                     proficiencyCodes.add(Number(p.textContent.trim()))
			);

			const raceSpellAb = ABILITY_INDEX_TO_KEY[this.getNumber(raceNode, 'spellAbility', 3)] || 'int';
			this.directChildren(raceNode, 'feat').forEach((f) => {
				const parsedF = this.parseFeatNode(f, raceName);
				allMods.push(...parsedF.mods);
				rawFeats.push(parsedF);
			});
			this.directChildren(raceNode, 'spell').forEach((sp) => {
				rawSpells.push(this.parseSpellNode(sp, raceName, raceSpellAb));
			});
		}

		const bgNode = this.directChild(charNode, 'background');
		let backgroundName = '';
		let alignment = '';
		let backgroundDetails = {};
		if (bgNode) {
			backgroundName = this.getText(bgNode, 'name', '');
			alignment = this.getText(bgNode, 'align', '');
			backgroundDetails = {
				name: backgroundName,
				alignment,
				personality: this.getText(bgNode, 'personality', ''),
				ideals: this.getText(bgNode, 'ideals', ''),
				bonds: this.getText(bgNode, 'bonds', ''),
				flaws: this.getText(bgNode, 'flaws', '')
			};

			this.directChildren(bgNode, 'proficiency').forEach((p) =>
				                                                   proficiencyCodes.add(Number(p.textContent.trim()))
			);
			this.directChildren(bgNode, 'feat').forEach((f) => {
				const parsedF = this.parseFeatNode(f, backgroundName);
				allMods.push(...parsedF.mods);
				rawFeats.push(parsedF);
			});
		}

		const classNodes = this.directChildren(charNode, 'class');
		const classesList = [];
		let primarySpellAbility = 'int';

		classNodes.forEach((clsNode, idx) => {
			const clsName = this.getText(clsNode, 'name', 'Class');
			const clsLevel = this.getNumber(clsNode, 'level', 1);
			const hdCode = this.getNumber(clsNode, 'hd', 2);
			const hdFaces = HD_FACES_MAP[hdCode] || 8;
			const hdCurrent = this.getNumber(clsNode, 'hdCurrent', clsLevel);
			const spellAbIdx = this.getNumber(clsNode, 'spellAbility', 0);
			const clsSpellAbility = ABILITY_INDEX_TO_KEY[spellAbIdx] || 'int';
			if (idx === 0 || spellAbIdx > 0) {
				primarySpellAbility = clsSpellAbility;
			}

			this.directChildren(clsNode, 'proficiency').forEach((p) =>
				                                                    proficiencyCodes.add(Number(p.textContent.trim()))
			);

			const slotsMaxArr = this.getText(clsNode, 'slots', '')
			                        .split(',')
			                        .filter((s) => s.trim() !== '')
			                        .map(Number);
			const slotsCurArr = this.getText(clsNode, 'slotsCurrent', '')
			                        .split(',')
			                        .filter((s) => s.trim() !== '')
			                        .map(Number);

			classesList.push({
				                 id: this.getText(clsNode, 'id', ''),
				                 name: clsName,
				                 level: clsLevel,
				                 hdFaces,
				                 hdCurrent,
				                 spellcastingAbility: clsSpellAbility,
				                 slotsReset: this.getNumber(clsNode, 'slotsReset', 2),
				                 slotsMax: slotsMaxArr,
				                 slotsCurrent: slotsCurArr,
				                 armorProficiencies: this.getText(clsNode, 'armor', ''),
				                 weaponProficiencies: this.getText(clsNode, 'weapons', ''),
				                 toolProficiencies: this.getText(clsNode, 'tools', '')
			                 });

			this.directChildren(clsNode, 'feat').forEach((f) => {
				const parsedF = this.parseFeatNode(f, `${clsName} ${clsLevel}`);
				allMods.push(...parsedF.mods);
				rawFeats.push(parsedF);
			});

			this.directChildren(clsNode, 'tracker').forEach((t) => {
				trackers.push(this.parseTrackerNode(t, clsName));
			});

			this.directChildren(clsNode, 'spell').forEach((sp) => {
				rawSpells.push(this.parseSpellNode(sp, clsName, clsSpellAbility));
			});
		});

		const totalLevel =
			classesList.reduce((acc, c) => acc + (Number(c.level) || 0), 0) ||
			this.getNumber(charNode, 'level', 1);
		const classesSummary =
			classesList.map((c) => `${c.name} ${c.level}`).join(' / ') || 'Adventurer 1';

		this.directChildren(charNode, 'feat').forEach((f) => {
			const parsedF = this.parseFeatNode(f, 'Feat');
			allMods.push(...parsedF.mods);
			rawFeats.push(parsedF);
		});

		this.directChildren(charNode, 'tracker').forEach((t) => {
			trackers.push(this.parseTrackerNode(t, ''));
		});

		const attacks = this.directChildren(charNode, 'attack').map((atkEl) => {
			const dmgTypeCode = this.getNumber(atkEl, 'damageType', 0);
			return {
				name: this.getText(atkEl, 'name', 'Attack'),
				typeCode: this.getNumber(atkEl, 'type', 1),
				attackBonusFormula: this.getText(atkEl, 'attackBonus', '0'),
				damageFormula: this.getText(atkEl, 'damage', '1d6'),
				damageTypeCode: dmgTypeCode
			};
		});

		const money = {pp: 0, gp: 0, ep: 0, sp: 0, cp: 0};
		const rawItems = [];
		const containers = [];

		const processParsedItem = (parsedIt) => {
			allMods.push(...parsedIt.mods);
			const lowName = parsedIt.name.toLowerCase();
			if (parsedIt.typeCode === 15 || /\((gp|sp|cp|pp|ep)\)/i.test(lowName)) {
				if (lowName.includes('(pp)') || lowName.includes('platinum')) {
					money.pp += parsedIt.count;
				} else if (lowName.includes('(gp)') || lowName.includes('gold')) {
					money.gp += parsedIt.count;
				} else if (lowName.includes('(ep)') || lowName.includes('electrum')) {
					money.ep += parsedIt.count;
				} else if (lowName.includes('(sp)') || lowName.includes('silver')) {
					money.sp += parsedIt.count;
				} else if (lowName.includes('(cp)') || lowName.includes('copper')) money.cp += parsedIt.count;
				return;
			}
			rawItems.push(parsedIt);
			if (parsedIt.damage1H && !attacks.some((a) => a.name === parsedIt.name)) {
				const meleeAbIdx = this.getNumber(charNode, 'meleeAbility', 0);
				const abToken = meleeAbIdx === 5 ? '%6' : '%1';
				attacks.push({
					             name: parsedIt.name,
					             typeCode: 1,
					             attackBonusFormula: `%8+${abToken}`,
					             damageFormula: `${parsedIt.damage1H}+${abToken}`,
					             damageTypeCode: parsedIt.damageTypeCode
				             });
			}
		};

		this.directChildren(charNode, 'item').forEach((itEl) => {
			processParsedItem(this.parseItemNode(itEl, ''));
		});

		this.directChildren(charNode, 'container').forEach((contEl) => {
			const contName = this.getText(contEl, 'label', '') || this.getText(contEl, 'name', 'Container');
			containers.push({
				                name: contName,
				                carried: this.getNumber(contEl, 'carried', 1) === 1,
				                ignoreWeight: this.getNumber(contEl, 'ignore', 0) === 1
			                });
			this.directChildren(contEl, 'item').forEach((itEl) => {
				processParsedItem(this.parseItemNode(itEl, contName));
			});
		});

		const effectiveAbilities = {...baseAbilities};
		let acBonusFromMods = 0;

		allMods.forEach((m) => {
			if (m.category === 1) {
				const abKey = ABILITY_INDEX_TO_KEY[m.type] || 'str';
				effectiveAbilities[abKey] = (effectiveAbilities[abKey] || 10) + (Number(m.value) || 0);
			}
			if (m.type === 10) {
				acBonusFromMods += Number(m.value) || 0;
			}
		});

		let calculatedAc = 10 + getAbilityModifier(effectiveAbilities.dex);
		const equippedArmor = rawItems.find((i) => i.ac >= 11 && i.equipped);
		if (equippedArmor) {
			const dexMod = getAbilityModifier(effectiveAbilities.dex);
			if (equippedArmor.typeCode === 3) {
				calculatedAc = equippedArmor.ac;
			} else if (equippedArmor.typeCode === 2) {
				calculatedAc = equippedArmor.ac + Math.min(2, dexMod);
			} else {
				calculatedAc = equippedArmor.ac + dexMod;
			}
		}
		const equippedShield = rawItems.find((i) => i.typeCode === 4 && (i.equipped || i.ac === 2));
		if (equippedShield) {
			calculatedAc += equippedShield.ac || 2;
		}
		calculatedAc += acBonusFromMods;

		const savingThrowProficiencies = [];
		const skillProficiencyKeys = [];

		for (const code of proficiencyCodes) {
			if (code >= 0 && code <= 5) {
				savingThrowProficiencies.push(ABILITY_INDEX_TO_KEY[code]);
			} else if (code >= 100 && code <= 117) {
				const sk = CORE_SKILLS.find((s) => s.code === code);
				if (sk) skillProficiencyKeys.push(sk.key);
			}
		}

		const notesList = this.directChildren(charNode, 'note').map((nEl) => ({
			name: this.getText(nEl, 'name', 'Note'),
			text: this.getText(nEl, 'text', ''),
			archived: this.getNumber(nEl, 'archived', 0) === 1
		}));

		const combinedNotesText = notesList
			.map((n) => `=== ${n.name.toUpperCase()} ===\n${n.text}`)
			.join('\n\n');

		const rawMonsters = this.directChildren(charNode, 'monster').map((mEl) =>
			                                                                 this.parseMonsterNode(mEl)
		);

		const charSlotsMax = this.getText(charNode, 'slots', '')
		                         .split(',')
		                         .filter((s) => s.trim() !== '')
		                         .map(Number);
		const charSlotsCur = this.getText(charNode, 'slotsCurrent', '')
		                         .split(',')
		                         .filter((s) => s.trim() !== '')
		                         .map(Number);

		const spellSlots = [];
		for (let lvl = 1; lvl <= 9; lvl++) {
			const maxStd = charSlotsMax[lvl] || 0;
			const curStd = charSlotsCur[lvl] ?? maxStd;
			if (maxStd > 0) {
				spellSlots.push({level: lvl, type: 'Standard', max: maxStd, current: curStd});
			}
		}
		classesList
			.filter((c) => c.slotsReset === 1)
			.forEach((warlockCls) => {
				for (let lvl = 1; lvl <= 9; lvl++) {
					const maxPact = warlockCls.slotsMax[lvl] || 0;
					const curPact = warlockCls.slotsCurrent[lvl] ?? maxPact;
					if (maxPact > 0) {
						spellSlots.push({
							                level: lvl,
							                type: `${warlockCls.name}`,
							                max: maxPact,
							                current: curPact
						                });
					}
				}
			});

		const character = {
			localId: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			fcUid: this.getText(charNode, 'uid', ''),
			name: this.getText(charNode, 'name', 'Unnamed Hero'),
			imageUid: characterImageUid,
			imageDriveMap: {},
			_pendingImages: extractedImages,
			level: totalLevel,
			experience: this.getNumber(charNode, 'exp', 0),
			race: raceName,
			raceDetails,
			background: backgroundName,
			backgroundDetails,
			alignment: alignment || 'Neutral',
			classes: classesList,
			classesRaw: classesSummary,
			spellcastingAbility: primarySpellAbility,
			inspiration: this.getText(charNode, 'inspiration', 'false') === 'true',
			ac: calculatedAc,
			hp: {
				max: this.getNumber(charNode, 'hpMax', this.getNumber(charNode, 'hp', 10)),
				current: this.getNumber(charNode, 'hpCurrent', this.getNumber(charNode, 'hp', 10)),
				temp: this.getNumber(charNode, 'hpTemp', 0)
			},
			baseAbilities,
			abilities: effectiveAbilities,
			savingThrowProficiencies,
			skills: skillProficiencyKeys.join(', '),
			money,
			spellSlots,
			attacks,
			trackers,
			containers,
			spells: [],
			items: [],
			feats: [],
			companions: [],
			notesList,
			notes: combinedNotesText,
			downtimeLog: []
		};

		if (dbService.isReady()) {
			try {
				const resolvedSpells = await dbService.resolveBatch(
					rawSpells.map((s) => ({table: 'spells', name: s.lookupName, source: s.source}))
				);
				character.spells = rawSpells.map((raw, i) => {
					const hit = resolvedSpells[i];
					return {
						dbId: hit ? hit.id : null,
						isCustom: !hit,
						customLabel: raw.name,
						origin: raw.origin,
						prepared: raw.prepared,
						rolls: raw.rolls,
						customData: raw
					};
				});

				const resolvedItems = await dbService.resolveBatch(
					rawItems.map((it) => ({table: 'items', name: it.lookupName, source: it.source}))
				);
				character.items = rawItems.map((raw, i) => {
					const hit = resolvedItems[i];
					return {
						dbId: hit ? hit.id : null,
						isCustom: !hit,
						customLabel: raw.name,
						container: raw.container,
						count: raw.count,
						equipped: raw.equipped,
						imageUid: raw.imageUid,
						customData: raw
					};
				});

				const resolvedFeats = await dbService.resolveBatch(
					rawFeats.map((f) => ({table: 'feats', name: f.lookupName, source: f.source}))
				);
				character.feats = rawFeats.map((raw, i) => {
					const hit = resolvedFeats[i];
					return {
						dbId: hit ? hit.id : null,
						isCustom: !hit,
						customLabel: raw.name,
						origin: raw.origin,
						customData: raw
					};
				});

				const resolvedMonsters = await dbService.resolveBatch(
					rawMonsters.map((m) => ({table: 'monsters', name: m.lookupName}))
				);
				character.companions = rawMonsters.map((raw, i) => {
					const hit = resolvedMonsters[i];
					return {
						dbId: hit ? hit.id : null,
						isCustom: !hit,
						...raw
					};
				});
			} catch (err) {
				console.warn('DB batch resolution fallback:', err);
			}
		}

		if (character.spells.length === 0 && rawSpells.length > 0) {
			character.spells = rawSpells.map((raw) => ({
				dbId: null,
				isCustom: true,
				customLabel: raw.name,
				origin: raw.origin,
				prepared: raw.prepared,
				rolls: raw.rolls,
				customData: raw
			}));
		}
		if (character.items.length === 0 && rawItems.length > 0) {
			character.items = rawItems.map((raw) => ({
				dbId: null,
				isCustom: true,
				customLabel: raw.name,
				container: raw.container,
				count: raw.count,
				equipped: raw.equipped,
				imageUid: raw.imageUid,
				customData: raw
			}));
		}
		if (character.feats.length === 0 && rawFeats.length > 0) {
			character.feats = rawFeats.map((raw) => ({
				dbId: null,
				isCustom: true,
				customLabel: raw.name,
				origin: raw.origin,
				customData: raw
			}));
		}
		if (character.companions.length === 0 && rawMonsters.length > 0) {
			character.companions = rawMonsters.map((raw) => ({
				dbId: null,
				isCustom: true,
				...raw
			}));
		}

		return character;
	}
}

export const fc5eImporter = new FightClub5eXmlImporter();