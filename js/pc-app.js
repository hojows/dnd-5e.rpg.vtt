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
		this.driveCharacterFiles = [];
		this.activeCharacter = null;
		this.activeCampaign = null;
		this.rollAdvantage = 0;
		this.sessionState = {
			connectionStatus: 'disconnected', // "disconnected" | "connecting" | "connected"
			masterRoomAvailable: false
		};
	}

	async init() {
		dbService.onStatusChange((dbState) => {
			uiBinder.updateDbStatusWidget(document.body, dbState);
			if (dbState.status === 'ready' && this.activeCharacter) {
				this.reconcileUnresolvedIdsAndRender();
			}
		});
		dbService.init();

		driveService.onAuthChange(async (authState) => {
			uiBinder.updateAuthWidget(document.body, authState);
			this.updateCampaignAndSessionBar();
			if (authState.authenticated) {
				await this.refreshDriveCharactersList();
			} else {
				this.driveCharacterFiles = [];
				this.renderCharacterSelector();
			}
		});

		this.setupP2PListeners();
		uiBinder.bindActions(document.body, this.getGlobalHandlers());

		const cachedActive = driveService.getActiveCharacterWorkingCopy();
		if (cachedActive) {
			await this.setActiveCharacter(cachedActive, false);
		} else {
			await this.createNewBlankCharacter();
		}
	}

	// =========================================================================
	// BARRA CAMPAGNA E INDICATORE STATO SESSIONE P2P
	// =========================================================================

	updateCampaignAndSessionBar() {
		const barEl = document.querySelector('[data-role="campaign-session-bar"]');
		if (!barEl) return;

		const hasCampaign = Boolean(this.activeCharacter?.campaignId);
		const isConnected = this.sessionState.connectionStatus === 'connected';
		const isConnecting = this.sessionState.connectionStatus === 'connecting';
		const isSessionAvailable = Boolean(this.sessionState.masterRoomAvailable);

		let indicatorLabel = 'Sessione Non Attiva (Master Offline)';
		if (isConnected) {
			indicatorLabel = 'Connesso alla Sessione Live';
		} else if (isConnecting) {
			indicatorLabel = 'Connessione alla Sessione in corso...';
		} else if (isSessionAvailable) {
			indicatorLabel = 'Sessione Attiva (Master Online)';
		}

		uiBinder.bindFields(barEl, {
			linkedCampaignName: this.activeCampaign?.campaignName || this.activeCharacter?.campaignName || 'Campagna Associata',
			sessionStatusText: indicatorLabel
		});

		uiBinder.bindVisibility(barEl, {
			hasNoCampaign: !hasCampaign,
			hasCampaign,
			isSessionOffline: hasCampaign && !isConnected && !isConnecting && !isSessionAvailable,
			isSessionReadyToJoin: hasCampaign && !isConnected && !isConnecting && isSessionAvailable,
			isSessionConnecting: hasCampaign && isConnecting,
			isSessionConnected: hasCampaign && isConnected,
			canJoinSession: hasCampaign && !isConnected && !isConnecting
		});

		uiBinder.bindEnabled(barEl, {
			isMasterSessionAvailable: isSessionAvailable
		});
	}

	// =========================================================================
	// GESTIONE PG ATTIVO E DRIVE
	// =========================================================================

	async refreshDriveCharactersList() {
		if (!driveService.isAuthenticated()) return;
		try {
			this.driveCharacterFiles = await driveService.listCharactersOnDrive();
			this.renderCharacterSelector();

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

		if (this.activeCharacter) {
			const currentOpt = document.createElement('option');
			currentOpt.value = this.activeCharacter.driveFileId || '__LOCAL_ACTIVE__';
			const dirtyTag = this.activeCharacter._dirty ? ' * (Non salvato)' : '';
			currentOpt.textContent = `${this.activeCharacter.name || 'Senza Nome'} (Liv. ${this.activeCharacter.level || 1})${dirtyTag}`;
			currentOpt.selected = true;
			selectEl.appendChild(currentOpt);
		}

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
		// Se stavamo connessi in P2P con un altro PG, disconnettiamoci prima
		if (this.sessionState.connectionStatus !== 'disconnected') {
			p2pService.disconnectPlayerClient(true, this.activeCharacter?.localId);
		}
		p2pService.stopSessionMonitor();

		this.activeCharacter = character;
		this.sessionState = {connectionStatus: 'disconnected', masterRoomAvailable: false};
		driveService.saveActiveCharacterWorkingCopy(this.activeCharacter, markDirty);
		this.updateSaveStatusIndicator();
		this.renderCharacterSelector();

		if (character.campaignId) {
			if (character.campaignDriveFileId) {
				try {
					this.activeCampaign = await driveService.refreshSharedCampaign(character.campaignDriveFileId);
				} catch (_) {
					this.activeCampaign = driveService.getActiveCampaignWorkingCopy();
				}
			} else {
				this.activeCampaign = driveService.getActiveCampaignWorkingCopy();
			}
			// Avvia il monitoraggio automatico per sapere se la sessione del Master è attiva
			p2pService.startSessionMonitor(character.campaignId);
		} else {
			this.activeCampaign = null;
		}

		this.updateCampaignAndSessionBar();
		await this.renderActiveSheet();
		await this.renderCampaignShop();
	}

	async createNewBlankCharacter() {
		const blank = {
			localId: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			driveFileId: null,
			campaignId: null,
			campaignName: null,
			campaignDriveFileId: null,
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

	async markModifiedAndSyncLocal(reason = 'manual_edit') {
		if (!this.activeCharacter) return;
		driveService.saveActiveCharacterWorkingCopy(this.activeCharacter, true);
		this.updateSaveStatusIndicator();
		this.renderCharacterSelector();
		p2pService.sendCharacterUpdateToMaster(this.activeCharacter, reason);
	}

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
			saveStatusText: isDirty ? 'Modifiche non salvate su Drive' : 'Salvato su Drive'
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

	// =========================================================================
	// LISTENER P2P LIVE
	// =========================================================================

	setupP2PListeners() {
		p2pService.on('SESSION_AVAILABILITY', ({campaignId, available}) => {
			if (this.activeCharacter?.campaignId !== campaignId) return;
			this.sessionState.masterRoomAvailable = available;
			this.updateCampaignAndSessionBar();
		});

		p2pService.on('STATUS_CHANGE', (st) => {
			this.sessionState.connectionStatus = st.status;
			if (st.status === 'connected') {
				this.sessionState.masterRoomAvailable = true;
			}
			this.updateCampaignAndSessionBar();
		});

		p2pService.on('SESSION_CLOSED_BY_MASTER', () => {
			this.sessionState.connectionStatus = 'disconnected';
			this.sessionState.masterRoomAvailable = false;
			this.updateCampaignAndSessionBar();
			this.showBanner('Il Master ha chiuso la sessione live.');
		});

		p2pService.on('CAMPAIGN_RECEIVED', async (freshCampaign) => {
			this.activeCampaign = freshCampaign;
			if (this.activeCharacter) {
				this.activeCharacter.campaignName = freshCampaign.campaignName;
			}
			driveService.saveActiveCampaignWorkingCopy(freshCampaign, false);
			this.updateCampaignAndSessionBar();
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

		p2pService.on('ERROR', ({error}) => {
			if (error) this.showBanner(error, true);
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
	// AZIONI GLOBALI DELLA PAGINA
	// =========================================================================

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
						'Hai modifiche non salvate su Google Drive per il PG attuale. Vuoi cambiare personaggio comunque?'
					);
					if (!confirmSwitch) {
						this.renderCharacterSelector();
						return;
					}
				}

				try {
					const loaded = await driveService.loadCharacterFromDrive(selectedDriveId);
					await this.setActiveCharacter(loaded, false);
					this.showBanner(`Personaggio "${loaded.name}" caricato!`);
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
					this.showBanner(`"${imported.name}" importato! Clicca su 'Salva PG su Drive' per salvarlo nel cloud.`);
				} catch (err) {
					this.showBanner(err.message, true);
				} finally {
					el.value = '';
				}
			},

			linkToCampaignPicker: async () => {
				try {
					const picked = await driveService.pickSharedJsonFile(
						'Seleziona il file della Campagna condiviso dal tuo Master'
					);
					if (!picked || !picked.content?.campaignId) return;

					const manifest = picked.content;
					manifest.driveFileId = picked.driveFileId;
					manifest.isMasterCopy = false;

					driveService.saveActiveCampaignWorkingCopy(manifest, false);
					this.activeCampaign = manifest;

					this.activeCharacter.campaignId = manifest.campaignId;
					this.activeCharacter.campaignName = manifest.campaignName;
					this.activeCharacter.campaignDriveFileId = picked.driveFileId;
					await this.saveActiveCharacterToCloud();

					if (this.activeCharacter.driveFileId && manifest.masterEmail) {
						await driveService.shareFileReadOnly(
							this.activeCharacter.driveFileId,
							manifest.masterEmail
						);
					}

					p2pService.startSessionMonitor(manifest.campaignId);
					this.updateCampaignAndSessionBar();
					await this.renderActiveSheet();
					await this.renderCampaignShop();
					this.showBanner(`PG associato alla campagna "${manifest.campaignName}"!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			unlinkFromCampaign: async () => {
				if (!this.activeCharacter?.campaignId) return;
				const ok = window.confirm(
					'Vuoi scollegare questo personaggio dalla campagna e riportarlo in Modalità Garage libera?'
				);
				if (!ok) return;

				if (this.sessionState.connectionStatus !== 'disconnected') {
					p2pService.disconnectPlayerClient(true, this.activeCharacter.localId);
				}
				p2pService.stopSessionMonitor();

				this.activeCharacter.campaignId = null;
				this.activeCharacter.campaignName = null;
				this.activeCharacter.campaignDriveFileId = null;
				this.activeCampaign = null;
				this.sessionState = {connectionStatus: 'disconnected', masterRoomAvailable: false};

				await this.markModifiedAndSyncLocal('unlinked_campaign');
				this.updateCampaignAndSessionBar();
				await this.renderActiveSheet();
				await this.renderCampaignShop();
				this.showBanner('Personaggio riportato in Modalità Garage.');
			},

			checkSessionNow: async () => {
				if (!this.activeCharacter?.campaignId) return;
				const available = await p2pService.probeMasterSession(this.activeCharacter.campaignId);
				if (available !== null) {
					this.sessionState.masterRoomAvailable = available;
					this.updateCampaignAndSessionBar();
				}
			},

			connectP2P: () => {
				const campId = this.activeCharacter?.campaignId;
				if (!campId) {
					this.showBanner('Associa prima il personaggio a una campagna.', true);
					return;
				}
				p2pService.connectAsPlayerClient(campId, {
					playerEmail: driveService.userProfile?.email || null,
					character: this.activeCharacter
				});
			},

			disconnectP2P: () => {
				p2pService.disconnectPlayerClient(true, this.activeCharacter?.localId);
				this.showBanner('Disconnesso dalla sessione live.');
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

	// =========================================================================
	// HANDLER DEI CAMPI DELLA SCHEDA (SINCRONIZZATI IN TEMPO REALE VIA P2P)
	// =========================================================================

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

				await this.markModifiedAndSyncLocal(`field_edit:${field}`);
				await this.renderActiveSheet();
			},

			updateAbilityScore: async (evt, el, ctx) => {
				if (!ctx?.abilityKey) return;
				this.activeCharacter.abilities[ctx.abilityKey] = Number(el.value) || 10;
				await this.markModifiedAndSyncLocal(`ability_edit:${ctx.abilityKey}`);
				await this.renderActiveSheet();
			},

			rollAbilityCheck: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.mod >= 0 ? `+${ctx.mod}` : `${ctx.mod}`;
				this.executeRoll(`1d20${sign}`, `Prova di ${ctx.label}`);
			},

			rollSavingThrow: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.saveBonus >= 0 ? `+${ctx.saveBonus}` : `${ctx.saveBonus}`;
				this.executeRoll(`1d20${sign}`, `TS ${ctx.label}`);
			},

			rollSkillCheck: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.bonus >= 0 ? `+${ctx.bonus}` : `${ctx.bonus}`;
				this.executeRoll(`1d20${sign}`, `Abilità: ${ctx.label}`);
			},

			rollAttackHit: (evt, el, ctx) => {
				if (!ctx) return;
				const sign = ctx.hitBonus >= 0 ? `+${ctx.hitBonus}` : `${ctx.hitBonus}`;
				this.executeRoll(`1d20${sign}`, `Colpire: ${ctx.name}`);
			},

			rollAttackDamage: (evt, el, ctx) => {
				if (!ctx?.damageFormula) return;
				this.executeRoll(ctx.damageFormula, `Danni: ${ctx.name}`);
			},

			rollSpellEffect: (evt, el, ctx) => {
				if (!ctx?.rollFormula) return;
				this.executeRoll(ctx.rollFormula, `${ctx.name}`);
			},

			updateTrackerValue: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.trackers?.[ctx.index]) return;
				this.activeCharacter.trackers[ctx.index].current = Number(el.value) || 0;
				await this.markModifiedAndSyncLocal('tracker_edit');
			},

			updateSpellSlotCurrent: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.spellSlots?.[ctx.index]) return;
				this.activeCharacter.spellSlots[ctx.index].current = Number(el.value) || 0;
				await this.markModifiedAndSyncLocal('slot_edit');
			},

			updateCompanionHp: async (evt, el, ctx) => {
				if (!ctx || !this.activeCharacter.companions?.[ctx.index]) return;
				this.activeCharacter.companions[ctx.index].hp.current = Number(el.value) || 0;
				await this.markModifiedAndSyncLocal('companion_hp');
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
				await this.markModifiedAndSyncLocal(`item_removed:${listType}`);
				await this.renderActiveSheet();
			}
		};
	}
}

const pcApp = new PlayerAppController();
window.addEventListener('DOMContentLoaded', () => pcApp.init());