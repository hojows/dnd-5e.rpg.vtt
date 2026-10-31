// js/rules-guard.js

// Valori in pezzi di rame (cp) secondo il regolamento D&D 5e
const COIN_RATES_IN_CP = {
	cp: 1,
	sp: 10,
	ep: 50,
	gp: 100,
	pp: 1000
};

class CampaignRulesGuard {
	/**
	 * Crea un manifesto di campagna vuoto con valori predefiniti per il Master.
	 */
	createDefaultCampaignManifest(campaignName, masterEmail) {
		return {
			campaignId: `camp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			campaignName: campaignName || 'Nuova Campagna D&D 5e',
			masterEmail: masterEmail || '',
			updatedAt: Date.now(),
			rules: {
				maxLevel: 1,
				allowManualLevelUp: false,
				allowManualAbilityEdit: false,
				allowManualMoneyEdit: false,
				allowFreeItemAddition: false,
				allowFreeSpellAddition: false,
				shopOpen: true
			},
			shopInventory: [], // [{ shopItemId, dbId, isCustom, customData, priceCp, stock, unlimited }]
			customCompendium: {}, // Elementi custom approvati dal Master per tutta la campagna
			partySnapshots: {} // localId -> { level, totalWealthCp, itemSignature, updatedAt }
		};
	}

	/**
	 * Restituisce i permessi operativi della UI per il personaggio corrente.
	 * Se il personaggio non appartiene a una campagna (Modalità Garage), tutto è consentito.
	 */
	getPermissions(character, campaignManifest = null) {
		const inCampaign = Boolean(character?.campaignId && campaignManifest);

		if (!inCampaign) {
			return {
				isCampaignBound: false,
				canLevelUp: (character?.level || 1) < 20,
				canEditAbilities: true,
				canEditMoneyManually: true,
				canAddAnyItem: true,
				canAddAnySpell: true,
				canPrepareSpells: true,
				canEditNotesAndBackground: true,
				canEditCombatStats: true, // PF, slot incantesimo, dadi vita, condizioni
				canAccessCampaignShop: false
			};
		}

		const rules = campaignManifest.rules || {};
		const currentLevel = Number(character.level) || 1;
		const maxAllowedLevel = Number(rules.maxLevel) || currentLevel;

		return {
			isCampaignBound: true,
			maxAllowedLevel,
			canLevelUp: currentLevel < maxAllowedLevel || Boolean(rules.allowManualLevelUp),
			canEditAbilities: Boolean(rules.allowManualAbilityEdit),
			canEditMoneyManually: Boolean(rules.allowManualMoneyEdit),
			canAddAnyItem: Boolean(rules.allowFreeItemAddition),
			canAddAnySpell: Boolean(rules.allowFreeSpellAddition),
			canPrepareSpells: true,
			canEditNotesAndBackground: true,
			canEditCombatStats: true,
			canAccessCampaignShop: Boolean(rules.shopOpen)
		};
	}

	// =========================================================================
	// GESTIONE VALUTA E ACQUISTI NEL NEGOZIO DI CAMPAGNA (DOWNTIME)
	// =========================================================================

	getTotalWealthInCp(money = {}) {
		return (
			(Number(money.cp) || 0) * COIN_RATES_IN_CP.cp +
			(Number(money.sp) || 0) * COIN_RATES_IN_CP.sp +
			(Number(money.ep) || 0) * COIN_RATES_IN_CP.ep +
			(Number(money.gp) || 0) * COIN_RATES_IN_CP.gp +
			(Number(money.pp) || 0) * COIN_RATES_IN_CP.pp
		);
	}

	/**
	 * Scala un importo in pezzi di rame (cp) dal borsellino del personaggio,
	 * preservando il più possibile le monete di taglio superiore e convertendo il resto.
	 */
	deductCostInCp(money, costCp) {
		const totalAvailableCp = this.getTotalWealthInCp(money);
		if (costCp > totalAvailableCp) {
			throw new Error('Fondi insufficienti per completare l\'acquisto.');
		}

		let remainingAfterPurchase = totalAvailableCp - costCp;

		const pp = Math.floor(remainingAfterPurchase / COIN_RATES_IN_CP.pp);
		remainingAfterPurchase %= COIN_RATES_IN_CP.pp;

		const gp = Math.floor(remainingAfterPurchase / COIN_RATES_IN_CP.gp);
		remainingAfterPurchase %= COIN_RATES_IN_CP.gp;

		const sp = Math.floor(remainingAfterPurchase / COIN_RATES_IN_CP.sp);
		remainingAfterPurchase %= COIN_RATES_IN_CP.sp;

		const cp = remainingAfterPurchase;

		return {pp, gp, ep: 0, sp, cp};
	}

	/**
	 * Esegue l'acquisto di un oggetto dal Negozio di Campagna del Master:
	 * verifica disponibilità e oro, scala le monete, aggiunge l'oggetto all'inventario
	 * e registra l'operazione nel downtimeLog del personaggio.
	 */
	purchaseFromCampaignShop(character, campaignManifest, shopItemId, quantity = 1) {
		const perms = this.getPermissions(character, campaignManifest);
		if (!perms.canAccessCampaignShop) {
			throw new Error('Il Negozio di Campagna è attualmente chiuso dal Master.');
		}

		const qty = Math.max(1, Math.floor(Number(quantity) || 1));
		const shopEntry = (campaignManifest.shopInventory || []).find(
			(i) => i.shopItemId === shopItemId
		);

		if (!shopEntry) {
			throw new Error('Oggetto non presente nel listino del negozio del Master.');
		}

		if (!shopEntry.unlimited && Number(shopEntry.stock) < qty) {
			throw new Error('Quantità richiesta non disponibile nel negozio.');
		}

		const unitPriceCp = Number(shopEntry.priceCp) || 0;
		const totalCostCp = unitPriceCp * qty;

		character.money = this.deductCostInCp(character.money || {}, totalCostCp);

		if (!Array.isArray(character.items)) {
			character.items = [];
		}

		// Verifica se il PG possiede già lo stesso oggetto per incrementarne la quantità
		const existingItem = character.items.find((it) =>
			                                          shopEntry.isCustom
			                                          ? it.isCustom && it.customData?.name === shopEntry.customData?.name
			                                          : !it.isCustom && it.dbId === shopEntry.dbId
		);

		if (existingItem) {
			existingItem.count = (Number(existingItem.count) || 1) + qty;
		} else {
			character.items.push({
				                     dbId: shopEntry.isCustom ? null : shopEntry.dbId,
				                     isCustom: Boolean(shopEntry.isCustom),
				                     count: qty,
				                     equipped: false,
				                     customData: shopEntry.isCustom ? {...shopEntry.customData} : null
			                     });
		}

		if (!Array.isArray(character.downtimeLog)) {
			character.downtimeLog = [];
		}

		character.downtimeLog.push({
			                           id: `dt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			                           timestamp: Date.now(),
			                           action: 'SHOP_PURCHASE',
			                           shopItemId: shopEntry.shopItemId,
			                           itemName: shopEntry.name || shopEntry.customData?.name || `Item #${shopEntry.dbId}`,
			                           quantity: qty,
			                           totalCostCp
		                           });

		return character;
	}

	// =========================================================================
	// VERIFICA INTEGRITÀ PER IL MASTER (SNAPSHOT AUDIT)
	// =========================================================================

	createCharacterSnapshot(character) {
		const totalWealthCp = this.getTotalWealthInCp(character.money);
		const itemsSig = (character.items || [])
			.map((i) => `${i.isCustom ? i.customData?.name : i.dbId}:${i.count || 1}`)
			.sort()
			.join('|');

		return {
			localId: character.localId,
			name: character.name,
			level: Number(character.level) || 1,
			totalWealthCp,
			itemsSig,
			timestamp: Date.now()
		};
	}

	/**
	 * Confronta lo stato attuale del PG con le regole della campagna e l'ultimo snapshot
	 * noto al Master, tenendo conto degli acquisti legittimi registrati in downtimeLog.
	 */
	auditCharacter(character, campaignManifest) {
		const warnings = [];
		if (!campaignManifest) return {valid: true, warnings};

		const maxLevel = Number(campaignManifest.rules?.maxLevel) || 20;
		if ((Number(character.level) || 1) > maxLevel) {
			warnings.push(
				`Livello PG (${character.level}) superiore al limite massimo della campagna (${maxLevel}).`
			);
		}

		const lastSnap = campaignManifest.partySnapshots?.[character.localId];
		if (lastSnap) {
			const spentInShopCp = (character.downtimeLog || [])
				.filter((e) => e.action === 'SHOP_PURCHASE' && e.timestamp > lastSnap.timestamp)
				.reduce((acc, e) => acc + (Number(e.totalCostCp) || 0), 0);

			const expectedWealthCp = lastSnap.totalWealthCp - spentInShopCp;
			const actualWealthCp = this.getTotalWealthInCp(character.money);

			if (actualWealthCp !== expectedWealthCp && !campaignManifest.rules?.allowManualMoneyEdit) {
				const diffGp = ((actualWealthCp - expectedWealthCp) / 100).toFixed(2);
				warnings.push(
					`Discrepanza valuta rilevata: differenza di ${diffGp} mo rispetto allo snapshot del Master e agli acquisti in negozio.`
				);
			}
		}

		return {
			valid: warnings.length === 0,
			warnings
		};
	}
}

export const rulesGuard = new CampaignRulesGuard();