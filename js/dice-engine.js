// js/dice-engine.js
import {evaluateFormula} from './formula-engine.js';

class DiceEngine {
	rollDie(sides) {
		return Math.floor(Math.random() * sides) + 1;
	}

	roll(notation, characterContext = {}, advantage = 0) {
		const evaluated = evaluateFormula(notation, characterContext);
		const expr = evaluated.expression;

		const diceRegex = /(\d*)d(\d+)/gi;
		const rollDetails = [];

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

		let total = 0;
		try {
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