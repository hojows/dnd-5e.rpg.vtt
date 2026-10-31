// js/gm-app.js
import {dbService} from './db-service.js';
import {diceEngine} from './dice-engine.js';
import {driveService} from './drive-service.js';
import {p2pService} from './p2p-service.js';
import {rulesGuard} from './rules-guard.js';
import {uiBinder} from './ui-binder.js';

class MasterAppController {
	constructor() {
		this.campaigns = [];
		this.activeCampaign = null;
		this.partyCharacters = new Map(); // localId -> { character, peerId, audit }
	}

	async init() {
		dbService.onStatusChange((dbState) => {
			uiBinder.updateDbStatusWidget(document.body, dbState);
			if (dbState.status === 'ready' && this.activeCampaign) {
				this.renderShopCatalogBuilder();
			}
		});
		dbService.init();

		driveService.onAuthChange((authState) => {
			uiBinder.bindFields(document.body, {
				userEmail: authState.user?.email || 'Master Offline'
			});
			uiBinder.bindVisibility(document.body, {
				isGoogleLogged: authState.authenticated,
				isGoogleLoggedOut: !authState.authenticated
			});
		});

		this.setupP2PListeners();
		uiBinder.bindActions(document.body, this.getGlobalHandlers());

		await this.loadCampaigns();
	}

	// =========================================================================
	// GESTIONE MANIFESTO DI CAMPAGNA E NEGOZIO DEL MASTER
	// =========================================================================

	async loadCampaigns() {
		const all = await driveService.getAllLocalRecords('campaigns');
		this.campaigns = all.filter((c) => c.isMasterCopy !== false);
		this.renderCampaignSelector();

		if (this.campaigns.length > 0 && !this.activeCampaign) {
			await this.selectCampaign(this.campaigns[0].campaignId);
		} else if (this.campaigns.length === 0) {
			await this.createNewCampaign();
		}
	}

	renderCampaignSelector() {
		const selectEl = document.querySelector('[data-role="campaign-selector"]');
		if (!selectEl) return;
		selectEl.replaceChildren();

		this.campaigns.forEach((camp) => {
			const opt = document.createElement('option');
			opt.value = camp.campaignId;
			opt.textContent = `${camp.campaignName} (Max Liv. ${camp.rules?.maxLevel || 1})`;
			if (this.activeCampaign && camp.campaignId === this.activeCampaign.campaignId) {
				opt.selected = true;
			}
			selectEl.appendChild(opt);
		});
	}

	async createNewCampaign() {
		const masterEmail = driveService.userProfile?.email || '';
		const manifest = rulesGuard.createDefaultCampaignManifest('Nuova Campagna', masterEmail);
		manifest.isMasterCopy = true;

		await driveService.saveCampaignManifest(manifest);
		this.campaigns.push(manifest);
		this.renderCampaignSelector();
		await this.selectCampaign(manifest.campaignId);
	}

	async selectCampaign(campaignId) {
		const found = this.campaigns.find((c) => c.campaignId === campaignId);
		if (!found) return;
		this.activeCampaign = found;
		this.renderCampaignSettings();
		await this.renderShopManager();
		this.renderPartyDashboard();
	}

	renderCampaignSettings() {
		if (!this.activeCampaign) return;
		const settingsRoot = document.querySelector('[data-role="gm-campaign-settings"]');
		if (!settingsRoot) return;

		uiBinder.bindFields(settingsRoot, {
			campaignId: this.activeCampaign.campaignId,
			campaignName: this.activeCampaign.campaignName,
			masterEmail: this.activeCampaign.masterEmail || driveService.userProfile?.email || '',
			rules: this.activeCampaign.rules
		});
	}

	async saveAndBroadcastCampaign() {
		if (!this.activeCampaign) return;
		if (driveService.userProfile?.email) {
			this.activeCampaign.masterEmail = driveService.userProfile.email;
		}
		await driveService.saveCampaignManifest(this.activeCampaign);
		this.renderCampaignSelector();
		p2pService.pushCampaignUpdateToParty(this.activeCampaign);
		this.showBanner('Campagna salvata su Drive e inviata in push a tutti i giocatori connessi!');
	}

	async renderShopManager() {
		const container = document.querySelector('[data-list="gm-shop-inventory"]');
		const emptyEl = document.querySelector('[data-empty="gm-shop-inventory"]');
		if (!container || !this.activeCampaign) return;

		const customRegistry = this.activeCampaign.customCompendium || null;
		const hydrated = await Promise.all(
			(this.activeCampaign.shopInventory || []).map(async (it) => {
				const h = await dbService.hydrateEntry('items', it, customRegistry);
				return {...h, ...it};
			})
		);

		uiBinder.renderList(
			container,
			'tpl-gm-shop-row',
			hydrated,
			(node, item, idx) => {
				const priceGp = (Number(item.priceCp || 0) / 100).toFixed(2);
				uiBinder.bindFields(node, {
					name: item.name || item.customData?.name || `Item #${item.dbId}`,
					priceCp: item.priceCp || 0,
					priceGpLabel: `${priceGp} mo`,
					stock: item.stock ?? 1,
					unlimited: Boolean(item.unlimited)
				});

				uiBinder.bindActions(node, {
					updateShopItemField: async (evt, el) => {
						const target = this.activeCampaign.shopInventory[idx];
						if (!target) return;
						const field = el.getAttribute('data-field');
						target[field] = el.type === 'checkbox' ? el.checked : Number(el.value);
						await this.saveAndBroadcastCampaign();
					},
					removeShopItem: async () => {
						this.activeCampaign.shopInventory.splice(idx, 1);
						await this.saveAndBroadcastCampaign();
						await this.renderShopManager();
					}
				});
			},
			emptyEl
		);
	}

	async renderShopCatalogBuilder(searchQuery = '') {
		if (!dbService.isReady()) return;
		const container = document.querySelector('[data-list="gm-db-items-catalog"]');
		if (!container) return;

		const items = await dbService.getItemsForShop({search: searchQuery, limit: 40});
		uiBinder.renderList(container, 'tpl-gm-catalog-item-row', items, (node, dbItem) => {
			const defaultCp = Number(dbItem.value_cp) || 500;
			uiBinder.bindFields(node, {
				name: dbItem.name,
				rarity: dbItem.rarity || 'Comune',
				defaultPriceGp: `${(defaultCp / 100).toFixed(2)} mo`
			});

			uiBinder.bindActions(node, {
				addDbItemToShop: async () => {
					this.activeCampaign.shopInventory.push({
						                                       shopItemId: `shop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						                                       dbId: dbItem.id,
						                                       name: dbItem.name,
						                                       isCustom: false,
						                                       priceCp: defaultCp,
						                                       stock: 5,
						                                       unlimited: false
					                                       });
					await this.saveAndBroadcastCampaign();
					await this.renderShopManager();
				}
			});
		});
	}

	// =========================================================================
	// DASHBOARD PARTY, AUDIT SNAPSHOT E ISPEZIONE SCHEDE PG
	// =========================================================================

	setupP2PListeners() {
		p2pService.on('STATUS_CHANGE', (st) => {
			uiBinder.bindFields(document.body, {
				p2pHostStatus:
					st.status === 'hosting'
					? `Stanza P2P Attiva (${st.roomId})`
					: 'Stanza P2P Non Avviata'
			});
		});

		p2pService.on('PLAYER_JOINED', ({peerId, character}) => {
			if (!character?.localId) return;
			const audit = rulesGuard.auditCharacter(character, this.activeCampaign);
			this.partyCharacters.set(character.localId, {character, peerId, audit});
			this.renderPartyDashboard();
			// Invia subito al giocatore il manifesto aggiornato della campagna
			p2pService.sendToPlayer(peerId, {
				type: 'CAMPAIGN_PUSH',
				campaign: this.activeCampaign,
				timestamp: Date.now()
			});
		});

		p2pService.on('CHARACTER_UPDATED', ({peerId, character}) => {
			if (!character?.localId) return;
			const audit = rulesGuard.auditCharacter(character, this.activeCampaign);
			this.partyCharacters.set(character.localId, {character, peerId, audit});
			this.renderPartyDashboard();
		});

		p2pService.on('DICE_ROLLED', (rollEntry) => {
			const logContainer = document.querySelector('[data-list="dice-log"]');
			uiBinder.prependDiceLogEntry(logContainer, 'tpl-dice-log-row', rollEntry);
		});
	}

	renderPartyDashboard() {
		const container = document.querySelector('[data-list="gm-party-cards"]');
		const emptyEl = document.querySelector('[data-empty="gm-party-cards"]');
		if (!container) return;

		const partyArray = Array.from(this.partyCharacters.values());

		uiBinder.renderList(
			container,
			'tpl-gm-party-card',
			partyArray,
			(node, entry) => {
				const ch = entry.character;
				const audit = entry.audit || {valid: true, warnings: []};
				const wealthGp = (rulesGuard.getTotalWealthInCp(ch.money) / 100).toFixed(2);

				uiBinder.bindFields(node, {
					name: ch.name,
					level: ch.level,
					race: ch.race,
					classesRaw: ch.classesRaw,
					hpSummary: `${ch.hp?.current ?? 0} / ${ch.hp?.max ?? 0} PF`,
					wealthSummary: `${wealthGp} mo`,
					auditStatusText: audit.valid ? 'Conforme alle regole' : audit.warnings.join(' | ')
				});

				uiBinder.bindVisibility(node, {
					hasAuditWarning: !audit.valid,
					isAuditValid: audit.valid
				});

				uiBinder.bindActions(node, {
					inspectPlayerSheet: async () => {
						const modalEl = document.getElementById('gm-inspect-modal');
						const modalBody = document.querySelector('[data-role="gm-inspect-sheet-container"]');
						if (!modalEl || !modalBody) return;
						await uiBinder.renderCharacterSheet(modalBody, ch, this.activeCampaign, {});
						modalEl.classList.remove('hidden');
					},

					approvePlayerSnapshot: async () => {
						this.activeCampaign.partySnapshots = this.activeCampaign.partySnapshots || {};
						this.activeCampaign.partySnapshots[ch.localId] = rulesGuard.createCharacterSnapshot(ch);
						entry.audit = rulesGuard.auditCharacter(ch, this.activeCampaign);
						await this.saveAndBroadcastCampaign();
						this.renderPartyDashboard();
					}
				});
			},
			emptyEl
		);
	}

	showBanner(message, isError = false) {
		const bannerEl = document.querySelector('[data-role="notification-banner"]');
		if (!bannerEl) return;
		bannerEl.textContent = message;
		bannerEl.classList.remove('hidden');
		bannerEl.dataset.variant = isError ? 'error' : 'info';
		setTimeout(() => bannerEl.classList.add('hidden'), 4500);
	}

	getGlobalHandlers() {
		return {
			loginGoogle: async () => {
				try {
					await driveService.signIn();
					await this.saveAndBroadcastCampaign();
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			logoutGoogle: () => driveService.signOut(),

			switchLanguage: async (evt, el) => {
				await dbService.setLanguage(el.value);
				await this.renderShopManager();
				await this.renderShopCatalogBuilder();
			},

			changeActiveCampaign: async (evt, el) => {
				await this.selectCampaign(el.value);
			},

			newCampaign: async () => {
				await this.createNewCampaign();
			},

			updateCampaignRule: async (evt, el) => {
				if (!this.activeCampaign) return;
				const field = el.getAttribute('data-field');
				if (field === 'campaignName') {
					this.activeCampaign.campaignName = el.value;
				} else if (field?.startsWith('rules.')) {
					const ruleKey = field.split('.')[1];
					this.activeCampaign.rules[ruleKey] =
						el.type === 'checkbox' ? el.checked : Number(el.value);
				}
				await this.saveAndBroadcastCampaign();
			},

			shareCampaignWithPlayerEmail: async () => {
				const input = document.querySelector('[data-field="sharePlayerEmail"]');
				const email = input?.value?.trim();
				if (!email) return;

				try {
					if (!this.activeCampaign.driveFileId) {
						await this.saveAndBroadcastCampaign();
					}
					await driveService.shareFileReadOnly(this.activeCampaign.driveFileId, email);
					input.value = '';
					this.showBanner(`Campagna condivisa in sola lettura su Drive con ${email}!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			inspectSharedCharacterFromDrive: async () => {
				try {
					const picked = await driveService.pickSharedJsonFile(
						'Seleziona la scheda PG condivisa da un giocatore'
					);
					if (!picked || !picked.content?.localId) return;
					const ch = picked.content;
					const audit = rulesGuard.auditCharacter(ch, this.activeCampaign);
					this.partyCharacters.set(ch.localId, {character: ch, peerId: null, audit});
					this.renderPartyDashboard();
					this.showBanner(`Scheda di "${ch.name}" caricata da Google Drive!`);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			startP2PHost: () => {
				if (!this.activeCampaign) return;
				p2pService.startAsMasterHost(this.activeCampaign.campaignId);
			},

			pushCampaignUpdate: async () => {
				await this.saveAndBroadcastCampaign();
			},

			searchDbShopCatalog: async (evt, el) => {
				await this.renderShopCatalogBuilder(el.value.trim());
			},

			closeInspectModal: () => {
				document.getElementById('gm-inspect-modal')?.classList.add('hidden');
			},

			quickRollDie: (evt, el) => {
				const die = el.getAttribute('data-die') || '1d20';
				const res = diceEngine.roll(die, {}, 0);
				const entry = {...res, rollerName: 'Dungeon Master', label: `DM ${die}`};
				const logContainer = document.querySelector('[data-list="dice-log"]');
				uiBinder.prependDiceLogEntry(logContainer, 'tpl-dice-log-row', entry);
				p2pService.sendDiceRoll(entry);
			}
		};
	}
}

const gmApp = new MasterAppController();
window.addEventListener('DOMContentLoaded', () => gmApp.init());