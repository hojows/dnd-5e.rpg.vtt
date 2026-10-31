// js/dice-engine.js
import {evaluateFormula} from './formula-engine.js';

class DiceEngine {
	/**
	 * Lancia un singolo dado a N facce
	 */
	rollDie(sides) {
		return Math.floor(Math.random() * sides) + 1;
	}

	/**
	 * Esegue un lancio basato su notazione standard (es. "2d6+3", "1d20+@STR_MOD")
	 * Supporta advantage: 1 (vantaggio), -1 (svantaggio), 0 (normale)
	 */
	roll(notation, characterContext = {}, advantage = 0) {
		const evaluated = evaluateFormula(notation, characterContext);
		const expr = evaluated.expression;

		// Pattern per riconoscere dadi es. "1d20", "2d6"
		const diceRegex = /(\d*)d(\d+)/gi;
		let breakdown = [];
		let rollDetails = [];

		const substitutedExpr = expr.replace(diceRegex, (match, countStr, sidesStr) => {
			const count = parseInt(countStr || '1', 10);
			const sides = parseInt(sidesStr, 10);
			let subTotal = 0;
			let rolls = [];

			if (sides === 20 && advantage !== 0) {
				const r1 = this.rollDie(20);
				const r2 = this.rollDie(20);
				rolls = [r1, r2];
				subTotal = advantage > 0 ? Math.max(r1, r2) : Math.min(r1, r2);
			} else {
				for (let i = 0; i < count; i++) {
					const r = this.rollDie(sides);
					rolls.push(r);
					subTotal += r;
				}
			}

			rollDetails.push({count, sides, rolls});
			return String(subTotal);
		});

		// Calcolo matematico sicuro del totale risultante
		let total = 0;
		try {
			// Semplice eval aritmetico sicuro post-sostituzione dadi
			total = Function(`"use strict"; return (${substitutedExpr})`)();
		} catch (_) {
			total = 0;
		}

		return {
			notation,
			expression: substitutedExpr,
			total: Math.round(total),
			rolls: rollDetails,
			timestamp: Date.now()
		};
	}
}

export const diceEngine = new DiceEngine();