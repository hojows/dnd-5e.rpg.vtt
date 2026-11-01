// js/formula-engine.js

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