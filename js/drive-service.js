// js/drive-service.js
import {APP_CONFIG} from './config.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file email profile';
const SESSION_TOKEN_KEY = 'dnd5e_google_oauth_session';
const ACTIVE_PC_CACHE_KEY = 'dnd5e_active_pc_working_copy';
const ACTIVE_CAMP_CACHE_KEY = 'dnd5e_active_campaign_working_copy';

class DriveStorageService {
	constructor() {
		this.accessToken = null;
		this.tokenClient = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		this.pickerApiLoaded = false;
		this.gisLoaded = false;
		this.authListeners = new Set();

		this.restoreSessionFromStorage();
	}

	// =========================================================================
	// 1. CACHE LOCALE SOLO PER IL SINGOLO PG / CAMPAGNA ATTIVA
	// =========================================================================

	saveActiveCharacterWorkingCopy(character, isDirty = true) {
		if (!character) return;
		character._dirty = isDirty;
		character.updatedAt = Date.now();
		try {
			localStorage.setItem(ACTIVE_PC_CACHE_KEY, JSON.stringify(character));
		} catch (e) {
			console.warn('Impossibile aggiornare la working copy locale:', e);
		}
	}

	getActiveCharacterWorkingCopy() {
		try {
			const raw = localStorage.getItem(ACTIVE_PC_CACHE_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch (_) {
			return null;
		}
	}

	clearActiveCharacterWorkingCopy() {
		localStorage.removeItem(ACTIVE_PC_CACHE_KEY);
	}

	saveActiveCampaignWorkingCopy(campaign, isDirty = true) {
		if (!campaign) return;
		campaign._dirty = isDirty;
		campaign.updatedAt = Date.now();
		try {
			localStorage.setItem(ACTIVE_CAMP_CACHE_KEY, JSON.stringify(campaign));
		} catch (e) {
			console.warn('Impossibile aggiornare la campagna attiva locale:', e);
		}
	}

	getActiveCampaignWorkingCopy() {
		try {
			const raw = localStorage.getItem(ACTIVE_CAMP_CACHE_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch (_) {
			return null;
		}
	}

	// =========================================================================
	// 2. GESTIONE SESSIONE GOOGLE OAUTH 2.0 E GOOGLE PICKER
	// =========================================================================

	restoreSessionFromStorage() {
		try {
			const saved = sessionStorage.getItem(SESSION_TOKEN_KEY);
			if (!saved) return;
			const parsed = JSON.parse(saved);
			if (parsed.expiresAt && Date.now() < parsed.expiresAt) {
				this.accessToken = parsed.accessToken;
				this.userProfile = parsed.userProfile;
				this.vaultFolderId = parsed.vaultFolderId || null;
			} else {
				sessionStorage.removeItem(SESSION_TOKEN_KEY);
			}
		} catch (_) {}
	}

	persistSessionToStorage(expiresInSec = 3500) {
		try {
			sessionStorage.setItem(
				SESSION_TOKEN_KEY,
				JSON.stringify({
					               accessToken: this.accessToken,
					               userProfile: this.userProfile,
					               vaultFolderId: this.vaultFolderId,
					               expiresAt: Date.now() + expiresInSec * 1000
				               })
			);
		} catch (_) {}
	}

	isAuthenticated() {
		return Boolean(this.accessToken);
	}

	onAuthChange(callback) {
		this.authListeners.add(callback);
		callback({
			         authenticated: Boolean(this.accessToken),
			         user: this.userProfile
		         });
		return () => this.authListeners.delete(callback);
	}

	notifyAuthChange() {
		const state = {
			authenticated: Boolean(this.accessToken),
			user: this.userProfile
		};
		for (const cb of this.authListeners) {
			cb(state);
		}
	}

	loadExternalScript(src) {
		return new Promise((resolve, reject) => {
			if (document.querySelector(`script[src="${src}"]`)) {
				resolve();
				return;
			}
			const script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Impossibile caricare lo script Google: ${src}`));
			document.head.appendChild(script);
		});
	}

	async ensureGoogleLibrariesLoaded() {
		if (!navigator.onLine) {
			throw new Error('Dispositivo offline: impossibile contattare Google Drive.');
		}
		if (!this.gisLoaded) {
			await this.loadExternalScript('https://accounts.google.com/gsi/client');
			this.gisLoaded = true;
		}
		if (!this.pickerApiLoaded) {
			await this.loadExternalScript('https://apis.google.com/js/api.js');
			await new Promise((resolve) => window.gapi.load('picker', {callback: resolve}));
			this.pickerApiLoaded = true;
		}
	}

	async signIn() {
		await this.ensureGoogleLibrariesLoaded();

		return new Promise((resolve, reject) => {
			this.tokenClient = window.google.accounts.oauth2.initTokenClient({
				                                                                 client_id: APP_CONFIG.GOOGLE_CLIENT_ID,
				                                                                 scope: DRIVE_SCOPE,
				                                                                 callback: async (tokenResponse) => {
					                                                                 if (tokenResponse.error) {
						                                                                 reject(new Error(tokenResponse.error_description || tokenResponse.error));
						                                                                 return;
					                                                                 }
					                                                                 this.accessToken = tokenResponse.access_token;
					                                                                 const expiresIn = Number(tokenResponse.expires_in) || 3500;
					                                                                 try {
						                                                                 await this.fetchUserProfile();
						                                                                 await this.ensureVaultFolder();
						                                                                 this.persistSessionToStorage(expiresIn);
						                                                                 this.notifyAuthChange();
						                                                                 resolve(this.userProfile);
					                                                                 } catch (err) {
						                                                                 reject(err);
					                                                                 }
				                                                                 }
			                                                                 });

			this.tokenClient.requestAccessToken({prompt: 'select_account'});
		});
	}

	signOut() {
		if (this.accessToken && window.google?.accounts?.oauth2) {
			window.google.accounts.oauth2.revoke(this.accessToken, () => {});
		}
		this.accessToken = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		sessionStorage.removeItem(SESSION_TOKEN_KEY);
		this.notifyAuthChange();
	}

	async fetchUserProfile() {
		const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
			headers: {Authorization: `Bearer ${this.accessToken}`}
		});
		if (!res.ok) throw new Error('Impossibile recuperare il profilo Google.');
		const data = await res.json();
		this.userProfile = {
			email: data.email,
			name: data.name || data.email,
			picture: data.picture || null
		};
		return this.userProfile;
	}

	// =========================================================================
	// 3. OPERAZIONI SU GOOGLE DRIVE API V3
	// =========================================================================

	async driveRequest(url, options = {}) {
		if (!this.accessToken) {
			throw new Error('Effettua prima l\'accesso a Google Drive.');
		}
		const headers = {
			Authorization: `Bearer ${this.accessToken}`,
			...(options.headers || {})
		};
		const response = await fetch(url, {...options, headers});
		if (response.status === 401) {
			this.signOut();
			throw new Error('Sessione Google Drive scaduta. Clicca nuovamente su Collega Google Drive.');
		}
		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Errore Google Drive (${response.status}): ${errText}`);
		}
		if (response.status === 204) return null;
		return response.json();
	}

	async ensureVaultFolder() {
		if (this.vaultFolderId) return this.vaultFolderId;

		const folderName = APP_CONFIG.DRIVE_VAULT_FOLDER;
		const q = encodeURIComponent(
			`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`
		);
		const searchRes = await this.driveRequest(
			`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
		);

		if (searchRes.files && searchRes.files.length > 0) {
			this.vaultFolderId = searchRes.files[0].id;
			return this.vaultFolderId;
		}

		const createRes = await this.driveRequest('https://www.googleapis.com/drive/v3/files', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				                     name: folderName,
				                     mimeType: 'application/vnd.google-apps.folder'
			                     })
		});

		this.vaultFolderId = createRes.id;
		return this.vaultFolderId;
	}

	async listFilesInVault(prefix = '') {
		const folderId = await this.ensureVaultFolder();
		const nameFilter = prefix ? ` and name contains '${prefix}'` : '';
		const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${nameFilter}`);
		const res = await this.driveRequest(
			`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`
		);
		return res.files || [];
	}

	async readJsonFileFromDrive(driveFileId) {
		return this.driveRequest(
			`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
		);
	}

	async saveJsonFileToDrive(fileName, jsonData, existingDriveFileId = null) {
		const folderId = await this.ensureVaultFolder();
		const metadata = existingDriveFileId
		                 ? {name: fileName, mimeType: 'application/json'}
		                 : {name: fileName, mimeType: 'application/json', parents: [folderId]};

		const boundary = '-------dnd5e_vtt_multipart_boundary';
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		const cleanData = {...jsonData};
		delete cleanData._dirty;

		const multipartBody =
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(metadata) +
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(cleanData, null, 2) +
			closeDelimiter;

		const url = existingDriveFileId
		            ? `https://www.googleapis.com/upload/drive/v3/files/${existingDriveFileId}?uploadType=multipart&fields=id,name,modifiedTime`
		            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime`;

		return this.driveRequest(url, {
			method: existingDriveFileId ? 'PATCH' : 'POST',
			headers: {'Content-Type': `multipart/related; boundary=${boundary}`},
			body: multipartBody
		});
	}

	async shareFileReadOnly(driveFileId, targetEmail) {
		if (!driveFileId || !targetEmail) return null;
		const url = `https://www.googleapis.com/drive/v3/files/${driveFileId}/permissions?sendNotificationEmail=false`;
		return this.driveRequest(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				                     role: 'reader',
				                     type: 'user',
				                     emailAddress: targetEmail.trim()
			                     })
		});
	}

	async pickSharedJsonFile(title = 'Seleziona il file condiviso su Google Drive') {
		await this.ensureGoogleLibrariesLoaded();
		if (!this.accessToken) {
			await this.signIn();
		}

		return new Promise((resolve, reject) => {
			const sharedView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
				.setMimeTypes('application/json')
				.setOwnedByMe(false)
				.setIncludeFolders(true);

			const myDriveView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
				.setMimeTypes('application/json');

			const picker = new window.google.picker.PickerBuilder()
				.setDeveloperKey(APP_CONFIG.GOOGLE_API_KEY)
				.setOAuthToken(this.accessToken)
				.setTitle(title)
				.addView(sharedView)
				.addView(myDriveView)
				.setCallback(async (data) => {
					if (data.action === window.google.picker.Action.PICKED) {
						const doc = data.docs[0];
						try {
							const content = await this.readJsonFileFromDrive(doc.id);
							resolve({driveFileId: doc.id, fileName: doc.name, content});
						} catch (err) {
							reject(err);
						}
					} else if (data.action === window.google.picker.Action.CANCEL) {
						resolve(null);
					}
				})
				.build();

			picker.setVisible(true);
		});
	}

	// =========================================================================
	// 4. CARICAMENTO E SALVATAGGIO CLOUD PER GIOCATORE E MASTER
	// =========================================================================

	/**
	 * Scarica l'elenco dei personaggi presenti nella cartella DND5E_Vault su Google Drive.
	 */
	async listCharactersOnDrive() {
		if (!this.isAuthenticated()) return [];
		return this.listFilesInVault('PG_');
	}

	/**
	 * Carica uno specifico personaggio da Google Drive e lo imposta come unica copia attiva in cache.
	 */
	async loadCharacterFromDrive(driveFileId) {
		const ch = await this.readJsonFileFromDrive(driveFileId);
		ch.driveFileId = driveFileId;
		this.saveActiveCharacterWorkingCopy(ch, false);
		return ch;
	}

	/**
	 * Salva il personaggio attivo su Google Drive e marca la copia locale come sincronizzata (_dirty = false).
	 */
	async saveCharacterToDrive(character) {
		if (!character.localId) {
			character.localId = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		character.updatedAt = Date.now();

		if (!this.isAuthenticated()) {
			this.saveActiveCharacterWorkingCopy(character, true);
			throw new Error('Collegati a Google Drive per salvare il personaggio nel cloud.');
		}

		const safeName = (character.name || 'PG').replace(/[^a-zA-Z0-9_-]/g, '_');
		const fileName = `PG_${safeName}_${character.localId}.json`;
		const meta = await this.saveJsonFileToDrive(fileName, character, character.driveFileId);
		if (meta && meta.id) {
			character.driveFileId = meta.id;
		}
		this.saveActiveCharacterWorkingCopy(character, false);
		return character;
	}

	async listCampaignsOnDrive() {
		if (!this.isAuthenticated()) return [];
		return this.listFilesInVault('CAMP_');
	}

	async loadCampaignFromDrive(driveFileId) {
		const camp = await this.readJsonFileFromDrive(driveFileId);
		camp.driveFileId = driveFileId;
		this.saveActiveCampaignWorkingCopy(camp, false);
		return camp;
	}

	async saveCampaignToDrive(campaign) {
		if (!campaign.campaignId) {
			campaign.campaignId = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		campaign.updatedAt = Date.now();

		if (!this.isAuthenticated()) {
			this.saveActiveCampaignWorkingCopy(campaign, true);
			throw new Error('Collegati a Google Drive per salvare la campagna nel cloud.');
		}

		const safeName = (campaign.campaignName || 'Campagna').replace(/[^a-zA-Z0-9_-]/g, '_');
		const fileName = `CAMP_${safeName}_${campaign.campaignId}.json`;
		const meta = await this.saveJsonFileToDrive(fileName, campaign, campaign.driveFileId);
		if (meta && meta.id) {
			campaign.driveFileId = meta.id;
		}
		this.saveActiveCampaignWorkingCopy(campaign, false);
		return campaign;
	}

	async refreshSharedCampaign(masterDriveFileId) {
		if (!this.isAuthenticated() || !navigator.onLine || !masterDriveFileId) {
			return this.getActiveCampaignWorkingCopy();
		}
		const freshManifest = await this.readJsonFileFromDrive(masterDriveFileId);
		freshManifest.driveFileId = masterDriveFileId;
		freshManifest.isMasterCopy = false;
		this.saveActiveCampaignWorkingCopy(freshManifest, false);
		return freshManifest;
	}
}

export const driveService = new DriveStorageService();