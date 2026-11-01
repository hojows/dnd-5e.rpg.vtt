// js/gm-app.js
import {dbService} from './db-service.js';
import {diceEngine} from './dice-engine.js';
import {driveService} from './drive-service.js';
import {i18nService} from './i18n-service.js';
import {p2pService} from './p2p-service.js';
import {rulesGuard} from './rules-guard.js';
import {uiBinder} from './ui-binder.js';

class MasterAppController {
	constructor() {
		this.driveCampaignFiles = [];
		this.activeCampaign = null;
		this.partyCharacters = new Map();
		this.inspectedCharacterId = null;
		this.hostStatus = 'disconnected';
		this.connectedPeersCount = 0;
	}

	async init() {
		dbService.onStatusChange((dbState) => {
			uiBinder.updateDbStatusWidget(document.body, dbState);
			if (dbState.status === 'ready' && this.activeCampaign) {
				this.renderShopCatalogBuilder();
			}
		});

		await dbService.init();

		driveService.onAuthChange(async (authState) => {
			uiBinder.updateAuthWidget(document.body, authState);
			if (authState.authenticated) {
				await this.refreshDriveCampaignsList();
			} else {
				this.driveCampaignFiles = [];
				this.renderCampaignSelector();
			}
		});

		this.setupP2PListeners();
		uiBinder.bindActions(document.body, this.getGlobalHandlers());

		const cachedCamp = driveService.getActiveCampaignWorkingCopy();
		if (cachedCamp && cachedCamp.isMasterCopy !== false) {
			await this.setActiveCampaign(cachedCamp);
		} else {
			await this.createNewCampaign();
		}

		this.updateMasterSessionBar();
	}

	updateMasterSessionBar() {
		const barEl = document.querySelector('[data-role="gm-session-bar"]');
		if (!barEl) return;

		const isHosting = this.hostStatus === 'hosting';
		const isConnecting = this.hostStatus === 'connecting';

		let statusText = i18nService.t('gm.sessionClosed', 'Live Session: Closed (Offline)');
		if (isHosting) {
			statusText = i18nService.t(
				'gm.sessionActive',
				'Live Session: ACTIVE ({count} PCs connected)',
				{count: this.connectedPeersCount}
			);
		} else if (isConnecting) {
			statusText = i18nService.t('gm.sessionConnecting', 'Opening P2P Room...');
		}

		uiBinder.bindFields(barEl, {
			p2pHostStatus: statusText
		});

		uiBinder.bindVisibility(barEl, {
			isSessionClosed: !isHosting && !isConnecting,
			isSessionHosting: isHosting
		});
	}

	async refreshDriveCampaignsList() {
		if (!driveService.isAuthenticated()) return;
		try {
			this.driveCampaignFiles = await driveService.listCampaignsOnDrive();
			this.renderCampaignSelector();

			const isInitialBlank =
				this.activeCampaign &&
				!this.activeCampaign.driveFileId &&
				(this.activeCampaign.campaignName === 'New Campaign' ||
				 this.activeCampaign.campaignName === 'Nuova Campagna');

			if (isInitialBlank && this.driveCampaignFiles.length > 0) {
				const loaded = await driveService.loadCampaignFromDrive(this.driveCampaignFiles[0].id);
				await this.setActiveCampaign(loaded);
			}
		} catch (err) {
			this.showBanner(err.message, true);
		}
	}

	renderCampaignSelector() {
		const selectEl = document.querySelector('[data-role="campaign-selector"]');
		if (!selectEl) return;
		selectEl.replaceChildren();

		const lvShort = i18nService.t('common.levelShort', 'Lv.');

		if (this.activeCampaign) {
			const opt = document.createElement('option');
			opt.value = this.activeCampaign.driveFileId || '__LOCAL_CAMP__';
			opt.textContent = `${this.activeCampaign.campaignName} (Max ${lvShort} ${
				                                                                       this.activeCampaign.rules?.maxLevel || 1
			})`;
			opt.selected = true;
			selectEl.appendChild(opt);
		}

		this.driveCampaignFiles.forEach((f) => {
			if (this.activeCampaign && f.id === this.activeCampaign.driveFileId) return;
			const opt = document.createElement('option');
			opt.value = f.id;
			opt.textContent = `☁️ ${f.name
			                         .replace(/^CAMP_/, '')
			                         .replace(/_camp_.*\.json$/, '')
			                         .replace(/_/g, ' ')}`;
			selectEl.appendChild(opt);
		});
	}

	async setActiveCampaign(campaign) {
		if (this.hostStatus === 'hosting') {
			p2pService.stopMasterHost(true);
		}
		this.activeCampaign = campaign;
		driveService.saveActiveCampaignWorkingCopy(campaign, false);
		this.renderCampaignSelector();
		this.renderCampaignSettings();
		await this.renderShopManager();
		await this.renderShopCatalogBuilder();
		this.renderPartyDashboard();
		this.updateMasterSessionBar();
	}

	async createNewCampaign() {
		const masterEmail = driveService.userProfile?.email || '';
		const defaultName = i18nService.t('gm.defaultCampaignName', 'New Campaign');
		const manifest = rulesGuard.createDefaultCampaignManifest(defaultName, masterEmail);
		manifest.isMasterCopy = true;
		await this.setActiveCampaign(manifest);
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
		driveService.saveActiveCampaignWorkingCopy(this.activeCampaign, true);
		p2pService.pushCampaignUpdateToParty(this.activeCampaign);

		if (driveService.isAuthenticated()) {
			this.activeCampaign.masterEmail = driveService.userProfile?.email || '';
			await driveService.saveCampaignToDrive(this.activeCampaign);
			await this.refreshDriveCampaignsList();
			this.showBanner(
				i18nService.t(
					'gm.toastCampaignSaved',
					'Campaign saved to Google Drive and pushed to the Party!'
				)
			);
		} else {
			this.showBanner(
				i18nService.t(
					'gm.toastCampaignLocal',
					'Rules updated and pushed via P2P (Sign in to Drive for cloud backup).'
				)
			);
		}
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
					name: item.name || item.customData?.name || `#${item.dbId}`,
					priceCp: item.priceCp || 0,
					priceGpLabel: `${priceGp} gp`,
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
				rarity: dbItem.rarity || '',
				defaultPriceGp: `${(defaultCp / 100).toFixed(2)} gp`
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

	setupP2PListeners() {
		p2pService.on('STATUS_CHANGE', (st) => {
			this.hostStatus = st.status;
			this.connectedPeersCount = st.connectedCount ?? 0;
			this.updateMasterSessionBar();
		});

		p2pService.on('PLAYER_JOINED', async ({peerId, character}) => {
			if (!character?.localId) return;
			const audit = rulesGuard.auditCharacter(character, this.activeCampaign);
			this.partyCharacters.set(character.localId, {
				character,
				peerId,
				online: true,
				audit
			});
			this.renderPartyDashboard();
			await this.refreshInspectModalIfOpen(character.localId);

			p2pService.sendToPlayer(peerId, {
				type: 'CAMPAIGN_PUSH',
				campaign: this.activeCampaign,
				timestamp: Date.now()
			});
		});

		p2pService.on('CHARACTER_UPDATED', async ({peerId, character}) => {
			if (!character?.localId) return;
			const audit = rulesGuard.auditCharacter(character, this.activeCampaign);
			this.partyCharacters.set(character.localId, {
				character,
				peerId,
				online: true,
				audit
			});
			this.renderPartyDashboard();
			await this.refreshInspectModalIfOpen(character.localId);
		});

		p2pService.on('PEER_DISCONNECTED', ({peerId, characterId}) => {
			for (const [id, entry] of this.partyCharacters.entries()) {
				if (entry.peerId === peerId || (characterId && id === characterId)) {
					entry.online = false;
					entry.peerId = null;
				}
			}
			this.renderPartyDashboard();
		});

		p2pService.on('DICE_ROLLED', (rollEntry) => {
			const logContainer = document.querySelector('[data-list="dice-log"]');
			uiBinder.prependDiceLogEntry(logContainer, 'tpl-dice-log-row', rollEntry);
		});
	}

	async refreshInspectModalIfOpen(characterId) {
		if (this.inspectedCharacterId !== characterId) return;
		const modalEl = document.getElementById('gm-inspect-modal');
		const modalBody = document.querySelector('[data-role="gm-inspect-sheet-container"]');
		const entry = this.partyCharacters.get(characterId);
		if (!modalEl || modalEl.classList.contains('hidden') || !modalBody || !entry) return;
		await uiBinder.renderCharacterSheet(modalBody, entry.character, this.activeCampaign, {});
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
					hpSummary: `${ch.hp?.current ?? 0} / ${ch.hp?.max ?? 0} HP`,
					wealthSummary: `${wealthGp} gp`,
					connectionBadge: entry.online
					                 ? i18nService.t('gm.onlineBadge', '🟢 Online Live')
					                 : i18nService.t('gm.offlineBadge', '⚪ Offline'),
					auditStatusText: audit.valid
					                 ? i18nService.t('gm.auditValid', 'Compliant with campaign rules')
					                 : audit.warnings.join(' | ')
				});

				uiBinder.bindVisibility(node, {
					hasAuditWarning: !audit.valid,
					isAuditValid: audit.valid
				});

				uiBinder.bindActions(node, {
					inspectPlayerSheet: async () => {
						this.inspectedCharacterId = ch.localId;
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
					const profile = await driveService.signIn();
					await this.refreshDriveCampaignsList();
					this.showBanner(
						i18nService.t('hub.toastConnected', 'Connected to Google Drive as {email}!', {
							email: profile.email
						})
					);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			logoutGoogle: () => driveService.signOut(),

			switchLanguage: async (evt, el) => {
				await dbService.setLanguage(el.value);
				uiBinder.updateDbStatusWidget(document.body, dbService.state);
				this.updateMasterSessionBar();
				this.renderCampaignSelector();
				this.renderPartyDashboard();
				await this.renderShopManager();
				await this.renderShopCatalogBuilder();
			},

			changeActiveCampaign: async (evt, el) => {
				const driveId = el.value;
				if (!driveId || driveId === '__LOCAL_CAMP__') return;
				try {
					const loaded = await driveService.loadCampaignFromDrive(driveId);
					await this.setActiveCampaign(loaded);
					this.showBanner(
						i18nService.t('gm.toastCampaignLoaded', 'Campaign "{name}" loaded from Drive!', {
							name: loaded.campaignName
						})
					);
				} catch (err) {
					this.showBanner(err.message, true);
				}
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
				driveService.saveActiveCampaignWorkingCopy(this.activeCampaign, true);
				this.renderCampaignSelector();
			},

			shareCampaignWithPlayerEmail: async () => {
				const input = document.querySelector('[data-field="sharePlayerEmail"]');
				const email = input?.value?.trim();
				if (!email) return;

				try {
					if (!driveService.isAuthenticated()) {
						await driveService.signIn();
					}
					if (!this.activeCampaign.driveFileId) {
						await driveService.saveCampaignToDrive(this.activeCampaign);
					}
					await driveService.shareFileReadOnly(this.activeCampaign.driveFileId, email);
					input.value = '';
					this.showBanner(
						i18nService.t(
							'gm.toastCampaignShared',
							'Campaign shared read-only on Drive with {email}!',
							{email}
						)
					);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			inspectSharedCharacterFromDrive: async () => {
				try {
					const picked = await driveService.pickSharedJsonFile();
					if (!picked || !picked.content?.localId) return;
					const ch = picked.content;
					const audit = rulesGuard.auditCharacter(ch, this.activeCampaign);
					this.partyCharacters.set(ch.localId, {
						character: ch,
						peerId: null,
						online: false,
						audit
					});
					this.renderPartyDashboard();
					this.showBanner(
						i18nService.t('gm.toastPcLoaded', 'Sheet for "{name}" loaded from Google Drive!', {
							name: ch.name
						})
					);
				} catch (err) {
					this.showBanner(err.message, true);
				}
			},

			startP2PHost: () => {
				if (!this.activeCampaign) return;
				p2pService.startAsMasterHost(this.activeCampaign.campaignId);
				this.showBanner(
					i18nService.t(
						'gm.toastSessionStarted',
						'Live Session started! Campaign players can now join.'
					)
				);
			},

			stopP2PHost: () => {
				p2pService.stopMasterHost(true);
				for (const entry of this.partyCharacters.values()) {
					entry.online = false;
					entry.peerId = null;
				}
				this.renderPartyDashboard();
				this.showBanner(i18nService.t('gm.toastSessionStopped', 'Live Session closed.'));
			},

			pushCampaignUpdate: async () => {
				await this.saveAndBroadcastCampaign();
			},

			searchDbShopCatalog: async (evt, el) => {
				await this.renderShopCatalogBuilder(el.value.trim());
			},

			closeInspectModal: () => {
				this.inspectedCharacterId = null;
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