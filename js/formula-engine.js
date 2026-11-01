// js/formula-engine.js

export const CORE_ABILITIES = [
	{key: 'str', index: 0},
	{key: 'dex', index: 1},
	{key: 'con', index: 2},
	{key: 'int', index: 3},
	{key: 'wis', index: 4},
	{key: 'cha', index: 5}
];

export const CORE_SKILLS = [
	{code: 100, monsterId: 0, key: 'acrobatics', engKey: 'Acrobatics', ability: 'dex'},
	{code: 101, monsterId: 1, key: 'animal_handling', engKey: 'Animal Handling', ability: 'wis'},
	{code: 102, monsterId: 2, key: 'arcana', engKey: 'Arcana', ability: 'int'},
	{code: 103, monsterId: 3, key: 'athletics', engKey: 'Athletics', ability: 'str'},
	{code: 104, monsterId: 4, key: 'deception', engKey: 'Deception', ability: 'cha'},
	{code: 105, monsterId: 5, key: 'history', engKey: 'History', ability: 'int'},
	{code: 106, monsterId: 6, key: 'insight', engKey: 'Insight', ability: 'wis'},
	{code: 107, monsterId: 7, key: 'intimidation', engKey: 'Intimidation', ability: 'cha'},
	{code: 108, monsterId: 8, key: 'investigation', engKey: 'Investigation', ability: 'int'},
	{code: 109, monsterId: 9, key: 'medicine', engKey: 'Medicine', ability: 'wis'},
	{code: 110, monsterId: 10, key: 'nature', engKey: 'Nature', ability: 'int'},
	{code: 111, monsterId: 11, key: 'perception', engKey: 'Perception', ability: 'wis'},
	{code: 112, monsterId: 12, key: 'performance', engKey: 'Performance', ability: 'cha'},
	{code: 113, monsterId: 13, key: 'persuasion', engKey: 'Persuasion', ability: 'cha'},
	{code: 114, monsterId: 14, key: 'religion', engKey: 'Religion', ability: 'int'},
	{code: 115, monsterId: 15, key: 'sleight_of_hand', engKey: 'Sleight of Hand', ability: 'dex'},
	{code: 116, monsterId: 16, key: 'stealth', engKey: 'Stealth', ability: 'dex'},
	{code: 117, monsterId: 17, key: 'survival', engKey: 'Survival', ability: 'wis'}
];

export function getAbilityModifier(score) {
	const val = Number(score) || 10;
	return Math.floor((val - 10) / 2);
}

/**
 * Valuta una stringa di formula dinamica supportando sia la sintassi @PB/@STR_MOD
 * sia la sintassi nativa di Fight Club 5e (%0, %1..%6, %8, SPELL, PROF).
 */
export function evaluateFormula(formulaStr, characterContext = {}) {
	if (formulaStr === undefined || formulaStr === null || formulaStr === '') {
		return {original: '', expression: '0', text: '0'};
	}

	let str = String(formulaStr).trim();
	const level = Number(characterContext.level) || 1;
	const pb = Number(characterContext.proficiencyBonus) || Math.ceil(level / 4) + 1;
	const abilities = characterContext.abilities || {
		str: 10,
		dex: 10,
		con: 10,
		int: 10,
		wis: 10,
		cha: 10
	};

	const mods = {
		str: getAbilityModifier(abilities.str ?? 10),
		dex: getAbilityModifier(abilities.dex ?? 10),
		con: getAbilityModifier(abilities.con ?? 10),
		int: getAbilityModifier(abilities.int ?? 10),
		wis: getAbilityModifier(abilities.wis ?? 10),
		cha: getAbilityModifier(abilities.cha ?? 10)
	};

	const spellAbilityKey = (characterContext.spellcastingAbility || 'int').toLowerCase();
	const spellMod = mods[spellAbilityKey] ?? mods.int;

	// Variabili Fight Club 5e (%0..%8, SPELL, PROF)
	const fcVars = {
		'%0': spellMod,
		'%1': mods.str,
		'%2': mods.dex,
		'%3': mods.con,
		'%4': mods.int,
		'%5': mods.wis,
		'%6': mods.cha,
		'%8': pb
	};

	for (const [token, val] of Object.entries(fcVars)) {
		str = str.split(token).join(String(val));
	}

	str = str.replace(/\bSPELL\b/g, String(spellMod));
	str = str.replace(/\bPROF\b/g, String(pb));
	str = str.replace(/@PB\b/gi, String(pb));
	str = str.replace(/@PROF_BONUS\b/gi, String(pb));
	str = str.replace(/@PROF\b/gi, String(pb));
	str = str.replace(/@LEVEL\b/gi, String(level));

	for (const [key, modVal] of Object.entries(mods)) {
		const regexMod = new RegExp(`@${key}_MOD\\b`, 'gi');
		str = str.replace(regexMod, String(modVal));
		const regexVal = new RegExp(`@${key}\\b(?![_a-zA-Z])`, 'gi');
		str = str.replace(regexVal, String(abilities[key] ?? 10));
	}

	// Normalizza doppi segni (es. "+-1" -> "-1")
	str = str.replace(/\+\s*-/g, '-');

	return {
		original: String(formulaStr),
		expression: str,
		text: str
	};
}