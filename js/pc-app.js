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
		this.driveCharacterFiles = []; // [{ id, name, modifiedTime }] letti da Google Drive
		this.activeCharacter = null;   // Unico PG tenuto nella cache locale
		this.activeCampaign = null;
		this.rollAdvantage = 0;
	}

	async init() {
		// 1. Avvia il DB SQLite in background
		dbService.onStatusChange((dbState) => {
			uiBinder.updateDbStatusWidget(document.body, dbState);
			if (dbState.status === 'ready' && this.activeCharacter) {
				this.reconcileUnresolvedIdsAndRender();
			}
		});
		dbService.init();

		// 2. Stato autenticazione Google Drive
		driveService.onAuthChange(async (authState) => {
			uiBinder.bindFields(document.body, {
				userEmail: authState.user?.email || 'Non connesso a Google Drive'
			});
			uiBinder.bindVisibility(document.body, {
				isGoogleLogged: authState.authenticated,
				isGoogleLoggedOut: !authState.authenticated
			});

			if (authState.authenticated) {
				await this.refreshDriveCharactersList();
			}
		});

		// 3. Listener P2P WebRTC
		this.setupP2PListeners();

		// 4. Azioni UI
		uiBinder.bindActions(document.body, this.getGlobalHandlers());

		// 5. Ripristina l'unico PG attivo dalla cache locale (o crea un PG vuoto)
		const cachedActive = driveService.getActiveCharacterWorkingCopy();
		if (cachedActive) {
			await this.setActiveCharacter(cachedActive, false);
		} else {
			await this.createNewBlankCharacter();
		}

		// 6. Se l'utente non è collegato a Google Drive, avvisa subito di collegarsi per caricare/salvare i PG
		if (!driveService.isAuthenticated()) {
			this.showBanner('Clicca su \'Collega Google Drive\' in alto a destra per caricare o salvare i tuoi PG nel cloud.');
		}
	}

	// =========================================================================
	// SINCRONIZZAZIONE CON GOOGLE DRIVE E CACHE DEL SINGOLO PG ATTIVO
	// =========================================================================

	async refreshDriveCharactersList() {
		if (!driveService.isAuthenticated()) return;
		try {
			this.driveCharacterFiles = await driveService.listCharactersOnDrive();
			this.renderCharacterSelector();

			// Se avevamo solo il PG vuoto iniziale e su Drive ci sono già PG salvati, carica automaticamente il più recente
			const isInitialBlank =
				this.activeCharacter &&
				!this.activeCharacter.driveFileId &&
				this.activeCharacter.name === 'Nuovo Avventuriero';

			if (isInitialBlank && this.driveCharacterFiles.length > 0) {
				const loaded = await driveService.loadCharacterFromDrive(this.driveCharacterFiles[0].id);
				await this.setActiveCharacter(loaded, false);
				this.showBanner(`Personaggio "${loaded.name}" caricato da Google Drive!`);
			}
		} catch (err) {
			this.showBanner(err.message, true);
		}
	}

	renderCharacterSelector() {
		const selectEl = document.querySelector('[data-role="character-selector"]');
		if (!selectEl) return;
		selectEl.replaceChildren();

		// Mostra sempre il PG attualmente aperto in locale in cima
		if (this.activeCharacter) {
			const currentOpt = document.createElement('option');
			currentOpt.value = this.activeCharacter.driveFileId || '__LOCAL_ACTIVE__';
			const dirtyTag = this.activeCharacter._dirty ? ' * (Non salvato)' : '';
			currentOpt.textContent = `${this.activeCharacter.name || 'Senza Nome'} (Liv. ${this.activeCharacter.level || 1})${dirtyTag}`;
			currentOpt.selected = true;
			selectEl.appendChild(currentOpt);
		}

		// Aggiungi gli altri PG presenti su Google Drive (senza scaricarli in cache finché non vengono selezionati)
		this.driveCharacterFiles.forEach((file) => {
			if (this.activeCharacter && file.id === this.activeCharacter.driveFileId) return;
			const opt = document.createElement('option');
			opt.value = file.id;
			const readableName = file.name.replace(/^PG_/, '').replace(/_pc_.*\.json$/, '').replace(/_/g, ' ');
			opt.textContent = `☁️ ${readableName}`;
			selectEl.appendChild(opt);
		});
	}

	async setActiveCharacter(character, markDirty = false) {
		this.activeCharacter = character;
		driveService.saveActiveCharacterWorkingCopy(this.activeCharacter, markDirty);
		this.updateSaveStatusIndicator();
		this.renderCharacterSelector();

		if (character.campaignDriveFileId) {
			try {
				this.activeCampaign = await driveService.refreshSharedCampaign(character.campaignDriveFileId);
			} catch (_) {
				this.activeCampaign = driveService.getActiveCampaignWorkingCopy();
			}
		} else {
			this.activeCampaign = null;
		}

		await this.renderActiveSheet();
		await this.renderCampaignShop();
	}

	async createNewBlankCharacter() {
		const blank = {
			localId: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			driveFileId: null,
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

		await this.setActiveCharacter(blank, true);
	}

	/**
	 * Aggiorna la copia di lavoro locale (unico PG in cache) e invia in P2P se connesso.
	 */
	async markModifiedAndSyncLocal(reason = 'manual_edit') {
		if (!this.activeCharacter) return;
		driveService.saveActiveCharacterWorkingCopy(this.activeCharacter, true);
		this.updateSaveStatusIndicator();
		this.renderCharacterSelector();
		p2pService.sendCharacterUpdateToMaster(this.activeCharacter, reason);
	}

	/**
	 * Salva esplicitamente il PG attivo su Google Drive.
	 */
	async saveActiveCharacterToCloud() {
		if (!this.activeCharacter) return;
		try {
			if (!driveService.isAuthenticated()) {
				await driveService.signIn();
			}
			await driveService.saveCharacterToDrive(this.activeCharacter);
			await this.refreshDriveCharactersList();
			this.updateSaveStatusIndicator();
			this.showBanner(`"${this.activeCharacter.name}" salvato su Google Drive!`);
		} catch (err) {
			this.showBanner(err.message, true);
		}
	}

	updateSaveStatusIndicator() {
		const isDirty = Boolean(this.activeCharacter?._dirty);
		uiBinder.bindFields(document.body, {
			saveStatusText: isDirty ? 'Modifiche locali non salvate su Drive' : 'Salvato su Drive'
		});
	}

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
			await this.markModifiedAndSyncLocal('db_reconcile');
		}
		await this.renderActiveSheet();
		await this.renderCampaignShop();
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
							await this.markModifiedAndSyncLocal('shop_purchase');
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

	setupP2PListeners() {
		p2pService.on('STATUS_CHANGE', (st) => {
			uiBinder.bindFields(document.body, {
				p2pStatusText:
					st.status === 'connected'
					? '🟢 Connesso al Master (Live)'
					: st.status === 'connecting'
					  ? '🟡 Connessione P2P in corso...'
					  : '⚪ P2P Disconnesso (Offline/Downtime)'
			});
		});

		p2pService.on('CAMPAIGN_RECEIVED', async (freshCampaign) => {
			this.activeCampaign = freshCampaign;
			driveService.saveActiveCampaignWorkingCopy(freshCampaign, false);
			await this.renderActiveSheet();
			await this.renderCampaignShop();
			this.showBanner('Il Master ha aggiornato le regole e il negozio della campagna!');
		});

		p2pService.on('GM_OVERRIDE_RECEIVED', async (patch) => {
			if (!this.activeCharacter || !patch) return;
			Object.assign(this.activeCharacter, patch);
			await this.markModifiedAndSyncLocal('gm_override');
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
		setTimeout(() => bannerEl.classList.add('hidden'), 5000);
	}

	getGlobalHandlers() {
		return {
			loginGoogle: async () => {
				try {
					await driveService.signIn();
					await this.refreshDriveCharactersList();
					this.showBanner('Google Drive collegato!');
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			logoutGoogle: () => {
				driveService.signOut();
			},

			saveCharacterExplicit: async () => {
				await this.saveActiveCharacterToCloud();
			},

			switchLanguage: async (evt, el) => {
				await dbService.setLanguage(el.value);
				await this.renderActiveSheet();
				await this.renderCampaignShop();
			},

			changeActiveCharacter: async (evt, el) => {
				const selectedDriveId = el.value;
				if (!selectedDriveId || selectedDriveId === '__LOCAL_ACTIVE__') return;

				if (this.activeCharacter?._dirty) {
					const confirmSwitch = window.confirm(
						'Hai modifiche non salvate su Google Drive per il PG attuale. Vuoi cambiare personaggio comunque (la cache locale verrà sostituita col nuovo PG)?'
					);
					if (!confirmSwitch) {
						this.renderCharacterSelector();
						return;
					}
				}

				try {
					const loaded = await driveService.loadCharacterFromDrive(selectedDriveId);
					await this.setActiveCharacter(loaded, false);
					this.showBanner(`Personaggio "${loaded.name}" caricato in memoria!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			newCharacter: async () => {
				if (this.activeCharacter?._dirty) {
					const ok = window.confirm(
						'Creando un nuovo PG sostituirai quello attuale nella cache locale. Continuare?'
					);
					if (!ok) return;
				}
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
					await this.setActiveCharacter(imported, true);
					this.showBanner(`"${imported.name}" importato! Clicca su 'Salva PG' per salvarlo su Google Drive.`);
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

					driveService.saveActiveCampaignWorkingCopy(manifest, false);
					this.activeCampaign = manifest;

					this.activeCharacter.campaignId = manifest.campaignId;
					this.activeCharacter.campaignDriveFileId = picked.driveFileId;
					await this.saveActiveCharacterToCloud();

					if (this.activeCharacter.driveFileId && manifest.masterEmail) {
						await driveService.shareFileReadOnly(
							this.activeCharacter.driveFileId,
							manifest.masterEmail
						);
					}

					await this.renderActiveSheet();
					await this.renderCampaignShop();
					this.showBanner(`PG associato alla campagna "${manifest.campaignName}"!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			connectP2P: () => {
				const campId =
					document.querySelector('[data-field="manualRoomId"]')?.value?.trim() ||
					this.activeCharacter?.campaignId;
				if (!campId) {
					this.showBanner('Collega prima una campagna da Drive o incolla l\'ID Stanza del Master.', true);
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
							await this.markModifiedAndSyncLocal('compendium_add');
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
				const val =
					      el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;

				const parts = field.split('.');
				if (parts.length === 2) {
					this.activeCharacter[parts[0]] = this.activeCharacter[parts[0]] || {};
					this.activeCharacter[parts[0]][parts[1]] = val;
				} else {
					this.activeCharacter[field] = val;
				}

				await this.markModifiedAndSyncLocal('field_edit');
				await this.renderActiveSheet();
			},

			updateAbilityScore: async (evt, el, ctx) => {
				if (!ctx?.abilityKey) return;
				this.activeCharacter.abilities[ctx.abilityKey] = Number(el.value) || 10;
				await this.markModifiedAndSyncLocal('ability_edit');
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
				await this.markModifiedAndSyncLocal('spell_prepared');
			},

			toggleItemEquipped: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.items[ctx.index]) return;
				this.activeCharacter.items[ctx.index].equipped = Boolean(el.checked);
				await this.markModifiedAndSyncLocal('item_equipped');
			},

			removeListItem: async (evt, el, ctx) => {
				const listType = el.getAttribute('data-list-type');
				if (!listType || !ctx || !Array.isArray(this.activeCharacter[listType])) return;
				this.activeCharacter[listType].splice(ctx.index, 1);
				await this.markModifiedAndSyncLocal('item_removed');
				await this.renderActiveSheet();
			}
		};
	}
}

const pcApp = new PlayerAppController();
window.addEventListener('DOMContentLoaded', () => pcApp.init());