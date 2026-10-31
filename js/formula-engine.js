// js/formula-engine.js

/**
 * Calcola il modificatore da un punteggio di caratteristica (es. 16 -> +3).
 */
export function getAbilityModifier(score) {
	const val = Number(score) || 10;
	return Math.floor((val - 10) / 2);
}

/**
 * Valuta una stringa di formula dinamica (es. "@PB + @STR_MOD + 2" oppure "1d8 + @INT_MOD")
 * Sostituisce le variabili standard con i valori effettivi del personaggio.
 */
export function evaluateFormula(formulaStr, characterContext = {}) {
	if (!formulaStr) return {formula: '', evaluated: 0, text: '0'};

	let str = String(formulaStr).trim();
	const pb = Number(characterContext.proficiencyBonus) || 2;
	const abilities = characterContext.abilities || {str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10};

	// Sostituzione variabili di caratteristica (sia estese es. @STR_MOD che brevi es. @str)
	const mods = {
		STR: getAbilityModifier(abilities.str ?? 10),
		DEX: getAbilityModifier(abilities.dex ?? 10),
		CON: getAbilityModifier(abilities.con ?? 10),
		INT: getAbilityModifier(abilities.int ?? 10),
		WIS: getAbilityModifier(abilities.wis ?? 10),
		CHA: getAbilityModifier(abilities.cha ?? 10),
		str: getAbilityModifier(abilities.str ?? 10),
		dex: getAbilityModifier(abilities.dex ?? 10),
		con: getAbilityModifier(abilities.con ?? 10),
		int: getAbilityModifier(abilities.int ?? 10),
		wis: getAbilityModifier(abilities.wis ?? 10),
		cha: getAbilityModifier(abilities.cha ?? 10)
	};

	str = str.replace(/@PB/gi, pb);
	str = str.replace(/@PROF/gi, pb);

	for (const [key, modVal] of Object.entries(mods)) {
		const regexMod = new RegExp(`@${key}_MOD`, 'gi');
		str = str.replace(regexMod, modVal);
		const regexVal = new RegExp(`@${key}(?![_a-zA-Z])`, 'gi');
		str = str.replace(regexVal, abilities[key.toLowerCase()] ?? 10);
	}

	// Sostituzione di altre variabili comuni
	str = str.replace(/@LEVEL/gi, characterContext.level || 1);
	str.replace(/@PROF_BONUS/gi, pb);

	return {
		original: formulaStr,
		expression: str,
		text: str
	};
}