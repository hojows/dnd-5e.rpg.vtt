// js/pc-app.js
import {dbService} from './db-service.js';
import {diceEngine} from './dice-engine.js';
import {driveService} from './drive-service.js';
import {fc5eImporter} from './importers/fc5e-xml-importer.js';
import {p2pService} from './p2p-service.js';
import {rulesGuard} from './rules-guard.js';
import {uiBinder} from './ui-binder.js';

class PlayerAppController {
	constructor() {
		this.characters = [];
		this.activeCharacter = null;
		this.activeCampaign = null;
		this.rollAdvantage = 0; // 0 = normale, 1 = vantaggio, -1 = svantaggio
		this.activeTab = 'combat';
	}

	async init() {
		// 1. Avvia il database SQLite in background (non bloccante)
		dbService.onStatusChange((dbState) => {
			uiBinder.updateDbStatusWidget(document.body, dbState);
			if (dbState.status === 'ready' && this.activeCharacter) {
				this.reconcileUnresolvedIdsAndRender();
			}
		});
		dbService.init();

		// 2. Ascolta lo stato di autenticazione Google Drive
		driveService.onAuthChange((authState) => {
			uiBinder.bindFields(document.body, {
				userEmail: authState.user?.email || 'Modalità Offline Locale'
			});
			uiBinder.bindVisibility(document.body, {
				isGoogleLogged: authState.authenticated,
				isGoogleLoggedOut: !authState.authenticated
			});
		});

		// 3. Configura i listener P2P WebRTC
		this.setupP2PListeners();

		// 4. Collega le azioni statiche della pagina HTML
		uiBinder.bindActions(document.body, this.getGlobalHandlers());

		// 5. Carica i personaggi salvati nel browser
		await this.loadCharacterVault();
	}

	// =========================================================================
	// GESTIONE GARAGE PERSONAGGI E CAMPAGNA CONDIVISA
	// =========================================================================

	async loadCharacterVault() {
		this.characters = await driveService.getAllLocalRecords('characters');
		this.renderCharacterSelector();

		if (this.characters.length > 0 && !this.activeCharacter) {
			await this.selectCharacter(this.characters[0].localId);
		} else if (this.characters.length === 0) {
			await this.createNewBlankCharacter();
		}
	}

	renderCharacterSelector() {
		const selectEl = document.querySelector('[data-role="character-selector"]');
		if (!selectEl) return;
		selectEl.replaceChildren();

		this.characters.forEach((ch) => {
			const opt = document.createElement('option');
			opt.value = ch.localId;
			opt.textContent = `${ch.name || 'Senza Nome'} (Liv. ${ch.level || 1})`;
			if (this.activeCharacter && ch.localId === this.activeCharacter.localId) {
				opt.selected = true;
			}
			selectEl.appendChild(opt);
		});
	}

	async selectCharacter(localId) {
		const found = this.characters.find((c) => c.localId === localId);
		if (!found) return;
		this.activeCharacter = found;
		this.activeCampaign = null;

		if (found.campaignId) {
			// Se il PG appartiene a una campagna, scarica eventuali aggiornamenti dal Drive del Master (anche per gli assenti)
			try {
				this.activeCampaign = await driveService.refreshSharedCampaign(
					found.campaignId,
					found.campaignDriveFileId
				);
			} catch (_) {
				this.activeCampaign = await driveService.getLocalRecord('campaigns', found.campaignId);
			}
		}

		await this.renderActiveSheet();
		await this.renderCampaignShop();
	}

	async createNewBlankCharacter() {
		const blank = {
			localId: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			name: 'Nuovo Avventuriero',
			level: 1,
			experience: 0,
			race: 'Umano',
			classesRaw: 'Guerriero 1',
			background: 'Soldato',
			alignment: 'Neutrale',
			inspiration: false,
			hp: {current: 10, max: 10, temp: 0},
			abilities: {str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10},
			skills: '',
			money: {pp: 0, gp: 10, ep: 0, sp: 0, cp: 0},
			spells: [],
			items: [],
			feats: [],
			downtimeLog: [],
			notes: ''
		};

		await driveService.saveCharacter(blank);
		this.characters.push(blank);
		this.renderCharacterSelector();
		await this.selectCharacter(blank.localId);
	}

	/**
	 * Se un XML è stato importato mentre il DB SQLite stava ancora scaricando,
	 * allinea automaticamente gli ID non appena il Worker comunica "ready".
	 */
	async reconcileUnresolvedIdsAndRender() {
		if (!this.activeCharacter || !dbService.isReady()) {
			await this.renderActiveSheet();
			return;
		}

		let modified = false;
		const resolveList = async (list, table) => {
			if (!Array.isArray(list)) return;
			for (const entry of list) {
				if (entry.isCustom && entry.customData?.name) {
					const found = await dbService.resolveEntity({
						                                            table,
						                                            name: entry.customData.name,
						                                            source: entry.customData.source
					                                            });
					if (found) {
						entry.dbId = found.id;
						entry.isCustom = false;
						modified = true;
					}
				}
			}
		};

		await resolveList(this.activeCharacter.spells, 'spells');
		await resolveList(this.activeCharacter.items, 'items');
		await resolveList(this.activeCharacter.feats, 'feats');

		if (modified) {
			await this.persistCharacter('db_reconcile');
		}
		await this.renderActiveSheet();
		await this.renderCampaignShop();
	}

	async persistCharacter(reason = 'manual_edit') {
		if (!this.activeCharacter) return;
		await driveService.saveCharacter(this.activeCharacter);
		this.renderCharacterSelector();
		p2pService.sendCharacterUpdateToMaster(this.activeCharacter, reason);
	}

	async renderActiveSheet() {
		const sheetRoot = document.querySelector('[data-role="pc-sheet-root"]');
		if (!sheetRoot || !this.activeCharacter) return;
		await uiBinder.renderCharacterSheet(
			sheetRoot,
			this.activeCharacter,
			this.activeCampaign,
			this.getSheetItemHandlers()
		);
	}

	// =========================================================================
	// NEGOZIO DI CAMPAGNA (DOWNTIME TRA LE SESSIONI)
	// =========================================================================

	async renderCampaignShop() {
		const shopContainer = document.querySelector('[data-list="campaign-shop"]');
		const emptyShopEl = document.querySelector('[data-empty="campaign-shop"]');
		if (!shopContainer) return;

		const shopList = this.activeCampaign?.shopInventory || [];
		const customRegistry = this.activeCampaign?.customCompendium || null;

		const hydratedShop = await Promise.all(
			shopList.map(async (entry) => {
				const hydrated = await dbService.hydrateEntry('items', entry, customRegistry);
				return {...hydrated, ...entry};
			})
		);

		uiBinder.renderList(
			shopContainer,
			'tpl-shop-item-row',
			hydratedShop,
			(node, item) => {
				const priceGp = (Number(item.priceCp || 0) / 100).toFixed(2);
				uiBinder.bindFields(node, {
					name: item.name || item.customData?.name || `Oggetto #${item.dbId}`,
					priceLabel: `${priceGp} mo (${item.priceCp} mr)`,
					stockLabel: item.unlimited ? 'Illimitato' : `Disponibili: ${item.stock}`,
					description: item.description || item.customData?.text || ''
				});

				uiBinder.bindActions(node, {
					buyShopItem: async () => {
						try {
							rulesGuard.purchaseFromCampaignShop(
								this.activeCharacter,
								this.activeCampaign,
								item.shopItemId,
								1
							);
							await this.persistCharacter('shop_purchase');
							await this.renderActiveSheet();
							await this.renderCampaignShop();
						} catch (err) {
							this.showBanner(err.message, true);
						}
					}
				});
			},
			emptyShopEl
		);
	}

	// =========================================================================
	// CONNESSIONE P2P WEBRTC COL MASTER
	// =========================================================================

	setupP2PListeners() {
		p2pService.on('STATUS_CHANGE', (st) => {
			uiBinder.bindFields(document.body, {
				p2pStatusText:
					st.status === 'connected'
					? 'Connesso al Master (Live)'
					: st.status === 'connecting'
					  ? 'Connessione P2P in corso...'
					  : 'P2P Disconnesso (Offline/Downtime)'
			});
		});

		p2pService.on('CAMPAIGN_RECEIVED', async (freshCampaign) => {
			this.activeCampaign = freshCampaign;
			await driveService.saveCampaignManifest({...freshCampaign, isMasterCopy: false});
			await this.renderActiveSheet();
			await this.renderCampaignShop();
			this.showBanner('Il Master ha aggiornato le regole e il negozio della campagna!');
		});

		p2pService.on('GM_OVERRIDE_RECEIVED', async (patch) => {
			if (!this.activeCharacter || !patch) return;
			Object.assign(this.activeCharacter, patch);
			await this.persistCharacter('gm_override');
			await this.renderActiveSheet();
			this.showBanner('Il Master ha aggiornato la tua scheda.');
		});

		p2pService.on('DICE_ROLLED', (rollEntry) => {
			const logContainer = document.querySelector('[data-list="dice-log"]');
			uiBinder.prependDiceLogEntry(logContainer, 'tpl-dice-log-row', rollEntry);
		});
	}

	executeRoll(notation, label = '') {
		if (!this.activeCharacter) return;
		const level = Number(this.activeCharacter.level) || 1;
		const context = {
			level,
			proficiencyBonus: Math.ceil(level / 4) + 1,
			abilities: this.activeCharacter.abilities
		};

		const result = diceEngine.roll(notation, context, this.rollAdvantage);
		const rollEntry = {
			...result,
			rollerName: this.activeCharacter.name,
			label: label || notation,
			advantage: this.rollAdvantage
		};

		const logContainer = document.querySelector('[data-list="dice-log"]');
		uiBinder.prependDiceLogEntry(logContainer, 'tpl-dice-log-row', rollEntry);
		p2pService.sendDiceRoll(rollEntry);
	}

	showBanner(message, isError = false) {
		const bannerEl = document.querySelector('[data-role="notification-banner"]');
		if (!bannerEl) return;
		bannerEl.textContent = message;
		bannerEl.classList.remove('hidden');
		bannerEl.dataset.variant = isError ? 'error' : 'info';
		setTimeout(() => bannerEl.classList.add('hidden'), 4500);
	}

	// =========================================================================
	// MAPPA DEGLI HANDLER DEGLI EVENTI (DATA-ACTION)
	// =========================================================================

	getGlobalHandlers() {
		return {
			loginGoogle: async () => {
				try {
					await driveService.signIn();
					await this.persistCharacter('google_login_sync');
					this.showBanner('Google Drive collegato con successo!');
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			logoutGoogle: () => {
				driveService.signOut();
			},

			switchLanguage: async (evt, el) => {
				await dbService.setLanguage(el.value);
				await this.renderActiveSheet();
				await this.renderCampaignShop();
			},

			changeActiveCharacter: async (evt, el) => {
				await this.selectCharacter(el.value);
			},

			newCharacter: async () => {
				await this.createNewBlankCharacter();
			},

			triggerImportXml: () => {
				document.getElementById('input-import-xml')?.click();
			},

			handleImportXmlFile: async (evt, el) => {
				const file = el.files?.[0];
				if (!file) return;
				try {
					const xmlText = await file.text();
					const imported = await fc5eImporter.parseXmlString(xmlText);
					await driveService.saveCharacter(imported);
					this.characters.push(imported);
					this.renderCharacterSelector();
					await this.selectCharacter(imported.localId);
					this.showBanner(`Personaggio "${imported.name}" importato da Fight Club 5e!`);
				} catch (err) {
					this.showBanner(err.message, true);
				} finally {
					el.value = '';
				}
			},

			linkToCampaignPicker: async () => {
				try {
					const picked = await driveService.pickSharedJsonFile();
					if (!picked || !picked.content?.campaignId) return;

					const manifest = picked.content;
					manifest.driveFileId = picked.driveFileId;
					manifest.isMasterCopy = false;

					await driveService.saveLocalRecord('campaigns', manifest);
					this.activeCampaign = manifest;

					this.activeCharacter.campaignId = manifest.campaignId;
					this.activeCharacter.campaignDriveFileId = picked.driveFileId;
					await this.persistCharacter('linked_to_campaign');

					// Condivide automaticamente il file del PG in sola lettura con l'email del Master
					if (this.activeCharacter.driveFileId && manifest.masterEmail) {
						await driveService.shareFileReadOnly(
							this.activeCharacter.driveFileId,
							manifest.masterEmail
						);
					}

					await this.renderActiveSheet();
					await this.renderCampaignShop();
					this.showBanner(`Personaggio associato alla campagna "${manifest.campaignName}"!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			connectP2P: () => {
				const campId =
					this.activeCharacter?.campaignId ||
					document.querySelector('[data-field="manualRoomId"]')?.value;
				if (!campId) {
					this.showBanner('Collega prima una campagna o inserisci il codice stanza.', true);
					return;
				}
				p2pService.connectAsPlayerClient(campId, {
					playerEmail: driveService.userProfile?.email || null,
					character: this.activeCharacter
				});
			},

			switchTab: (evt, el) => {
				const targetTab = el.getAttribute('data-tab-target');
				if (!targetTab) return;
				document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
					panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== targetTab);
				});
			},

			setRollAdvantage: (evt, el) => {
				this.rollAdvantage = Number(el.getAttribute('data-adv') || 0);
			},

			quickRollDie: (evt, el) => {
				const die = el.getAttribute('data-die') || '1d20';
				this.executeRoll(die, `Lancio ${die}`);
			},

			rollCustomFormula: () => {
				const input = document.querySelector('[data-field="customDiceFormula"]');
				if (input && input.value.trim()) {
					this.executeRoll(input.value.trim(), 'Formula Custom');
				}
			},

			searchCompendiumInput: async (evt, el) => {
				const q = el.value.trim();
				const cat = document.querySelector('[data-field="compendiumCategory"]')?.value || null;
				const resultsContainer = document.querySelector('[data-list="compendium-results"]');
				if (!q || !resultsContainer) return;

				const results = await dbService.search(q, cat, 30);
				const perms = rulesGuard.getPermissions(this.activeCharacter, this.activeCampaign);

				uiBinder.renderList(resultsContainer, 'tpl-compendium-result-row', results, (node, r) => {
					uiBinder.bindFields(node, {
						name: r.name,
						category: r.category,
						source: r.source,
						details: r.details || ''
					});

					uiBinder.bindActions(node, {
						addCompendiumEntryToCharacter: async () => {
							if (r.category === 'spells' && !perms.canAddAnySpell) {
								this.showBanner('Aggiunta libera incantesimi disabilitata dal Master.', true);
								return;
							}
							if (r.category === 'items' && !perms.canAddAnyItem) {
								this.showBanner('Usa il Negozio di Campagna per acquistare oggetti.', true);
								return;
							}
							if (r.category === 'spells') {
								this.activeCharacter.spells.push({dbId: r.id, isCustom: false, prepared: true});
							} else if (r.category === 'items') {
								this.activeCharacter.items.push({
									                                dbId: r.id,
									                                isCustom: false,
									                                count: 1,
									                                equipped: false
								                                });
							} else if (r.category === 'feats') {
								this.activeCharacter.feats.push({dbId: r.id, isCustom: false});
							}
							await this.persistCharacter('compendium_add');
							await this.renderActiveSheet();
							this.showBanner(`"${r.name}" aggiunto alla scheda!`);
						}
					});
				});
			}
		};
	}

	getSheetItemHandlers() {
		return {
			updateBasicField: async (evt, el) => {
				const field = el.getAttribute('data-field');
				if (!field || !this.activeCharacter) return;
				const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;

				const parts = field.split('.');
				if (parts.length === 2) {
					this.activeCharacter[parts[0]] = this.activeCharacter[parts[0]] || {};
					this.activeCharacter[parts[0]][parts[1]] = val;
				} else {
					this.activeCharacter[field] = val;
				}

				await this.persistCharacter('field_edit');
				await this.renderActiveSheet();
			},

			updateAbilityScore: async (evt, el, ctx) => {
				if (!ctx?.abilityKey) return;
				this.activeCharacter.abilities[ctx.abilityKey] = Number(el.value) || 10;
				await this.persistCharacter('ability_edit');
				await this.renderActiveSheet();
			},

			rollAbilityCheck: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.mod >= 0 ? `+${ctx.mod}` : `${ctx.mod}`;
				this.executeRoll(`1d20${sign}`, `Prova di ${ctx.label}`);
			},

			rollSkillCheck: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.bonus >= 0 ? `+${ctx.bonus}` : `${ctx.bonus}`;
				this.executeRoll(`1d20${sign}`, `Abilità: ${ctx.label}`);
			},

			toggleSpellPrepared: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.spells[ctx.index]) return;
				this.activeCharacter.spells[ctx.index].prepared = Boolean(el.checked);
				await this.persistCharacter('spell_prepared');
			},

			toggleItemEquipped: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.items[ctx.index]) return;
				this.activeCharacter.items[ctx.index].equipped = Boolean(el.checked);
				await this.persistCharacter('item_equipped');
			},

			removeListItem: async (evt, el, ctx) => {
				const listType = el.getAttribute('data-list-type');
				if (!listType || !ctx || !Array.isArray(this.activeCharacter[listType])) return;
				this.activeCharacter[listType].splice(ctx.index, 1);
				await this.persistCharacter('item_removed');
				await this.renderActiveSheet();
			}
		};
	}
}

const pcApp = new PlayerAppController();
window.addEventListener('DOMContentLoaded', () => pcApp.init());