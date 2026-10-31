// js/drive-service.js
import {APP_CONFIG} from './config.js';

const LOCAL_IDB_NAME = 'DND5E_Local_User_Vault';
const LOCAL_IDB_VERSION = 1;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file email profile';

class DriveStorageService {
	constructor() {
		this.accessToken = null;
		this.tokenClient = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		this.pickerApiLoaded = false;
		this.gisLoaded = false;
		this.authListeners = new Set();
	}

	// =========================================================================
	// 1. PERSISTENZA LOCALE (INDEXEDDB) PER OPERATIVITÀ OFFLINE IMMEDIATA
	// =========================================================================

	openLocalVault() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(LOCAL_IDB_NAME, LOCAL_IDB_VERSION);
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains('characters')) {
					db.createObjectStore('characters', {keyPath: 'localId'});
				}
				if (!db.objectStoreNames.contains('campaigns')) {
					db.createObjectStore('campaigns', {keyPath: 'campaignId'});
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async saveLocalRecord(storeName, record) {
		const db = await this.openLocalVault();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).put(record);
			tx.oncomplete = () => resolve(record);
			tx.onerror = () => reject(tx.error);
		});
	}

	async getLocalRecord(storeName, key) {
		const db = await this.openLocalVault();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readonly');
			const req = tx.objectStore(storeName).get(key);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => reject(req.error);
		});
	}

	async getAllLocalRecords(storeName) {
		const db = await this.openLocalVault();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readonly');
			const req = tx.objectStore(storeName).getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => reject(req.error);
		});
	}

	async deleteLocalRecord(storeName, key) {
		const db = await this.openLocalVault();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	// =========================================================================
	// 2. AUTENTICAZIONE OAUTH 2.0 (GOOGLE IDENTITY SERVICES) E PICKER LOADER
	// =========================================================================

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
			const existing = document.querySelector(`script[src="${src}"]`);
			if (existing) {
				resolve();
				return;
			}
			const script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Impossibile caricare lo script: ${src}`));
			document.head.appendChild(script);
		});
	}

	async ensureGoogleLibrariesLoaded() {
		if (!navigator.onLine) {
			throw new Error('Dispositivo offline: impossibile contattare i server Google.');
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
					                                                                 try {
						                                                                 await this.fetchUserProfile();
						                                                                 await this.ensureVaultFolder();
						                                                                 this.notifyAuthChange();
						                                                                 resolve(this.userProfile);
					                                                                 } catch (err) {
						                                                                 reject(err);
					                                                                 }
				                                                                 }
			                                                                 });

			this.tokenClient.requestAccessToken({prompt: ''});
		});
	}

	signOut() {
		if (this.accessToken && window.google?.accounts?.oauth2) {
			window.google.accounts.oauth2.revoke(this.accessToken, () => {});
		}
		this.accessToken = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		this.notifyAuthChange();
	}

	async fetchUserProfile() {
		const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
			headers: {Authorization: `Bearer ${this.accessToken}`}
		});
		if (!res.ok) throw new Error('Impossibile recuperare il profilo utente Google.');
		const data = await res.json();
		this.userProfile = {
			email: data.email,
			name: data.name || data.email,
			picture: data.picture || null
		};
		return this.userProfile;
	}

	// =========================================================================
	// 3. OPERAZIONI SUL GOOGLE DRIVE PERSONALE (REST API V3)
	// =========================================================================

	async driveRequest(url, options = {}) {
		if (!this.accessToken) {
			throw new Error('Non autenticato su Google Drive.');
		}
		const headers = {
			Authorization: `Bearer ${this.accessToken}`,
			...(options.headers || {})
		};
		const response = await fetch(url, {...options, headers});
		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Errore Google Drive API (${response.status}): ${errText}`);
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

	async saveJsonFileToDrive(fileName, jsonData, existingDriveFileId = null) {
		const folderId = await this.ensureVaultFolder();
		const metadata = existingDriveFileId
		                 ? {name: fileName, mimeType: 'application/json'}
		                 : {name: fileName, mimeType: 'application/json', parents: [folderId]};

		const boundary = '-------dnd5e_vtt_multipart_boundary';
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		const multipartBody =
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(metadata) +
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(jsonData, null, 2) +
			closeDelimiter;

		const url = existingDriveFileId
		            ? `https://www.googleapis.com/upload/drive/v3/files/${existingDriveFileId}?uploadType=multipart&fields=id,name,modifiedTime`
		            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime`;

		return this.driveRequest(url, {
			method: existingDriveFileId ? 'PATCH' : 'POST',
			headers: {
				'Content-Type': `multipart/related; boundary=${boundary}`
			},
			body: multipartBody
		});
	}

	async readJsonFileFromDrive(driveFileId) {
		return this.driveRequest(
			`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
		);
	}

	async listFilesInVault(prefix = '') {
		const folderId = await this.ensureVaultFolder();
		const nameFilter = prefix ? ` and name contains '${prefix}'` : '';
		const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${nameFilter}`);
		const res = await this.driveRequest(
			`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`
		);
		return res.files || [];
	}

	/**
	 * Condivide un file su Google Drive in sola lettura (reader) con un indirizzo email specifico.
	 * Usato dal Master per condividere campaign.json con i giocatori,
	 * e dal Giocatore per condividere il proprio PG con il Master.
	 */
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

	// =========================================================================
	// 4. GOOGLE PICKER API (SELEZIONE FILE CONDIVISI CON AMBITO DRIVE.FILE)
	// =========================================================================

	/**
	 * Apre il popup nativo di Google Drive mostrando i file condivisi con l'utente.
	 * Quando l'utente seleziona il file (es. campaign.json del Master), Google
	 * autorizza permanentemente l'app a leggere quel file con lo scope drive.file.
	 */
	async pickSharedJsonFile(title = 'Seleziona il file della Campagna condiviso dal Master') {
		await this.ensureGoogleLibrariesLoaded();
		if (!this.accessToken) {
			await this.signIn();
		}

		return new Promise((resolve, reject) => {
			const sharedView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
				.setMimeTypes('application/json')
				.setOwnedByMe(false)
				.setIncludeFolders(true);

			const allJsonView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
				.setMimeTypes('application/json');

			const picker = new window.google.picker.PickerBuilder()
				.setDeveloperKey(APP_CONFIG.GOOGLE_API_KEY)
				.setOAuthToken(this.accessToken)
				.setTitle(title)
				.addView(sharedView)
				.addView(allJsonView)
				.setCallback(async (data) => {
					if (data.action === window.google.picker.Action.PICKED) {
						const doc = data.docs[0];
						try {
							const content = await this.readJsonFileFromDrive(doc.id);
							resolve({
								        driveFileId: doc.id,
								        fileName: doc.name,
								        content
							        });
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
	// 5. METODI AD ALTO LIVELLO PER PERSONAGGI E CAMPAGNE (OFFLINE + CLOUD)
	// =========================================================================

	async saveCharacter(character) {
		if (!character.localId) {
			character.localId = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		character.updatedAt = Date.now();

		// 1. Salva sempre subito in IndexedDB locale (non bloccante, funziona offline)
		await this.saveLocalRecord('characters', character);

		// 2. Se l'utente è connesso a Google Drive ed è online, sincronizza in cloud
		if (this.accessToken && navigator.onLine) {
			const safeName = (character.name || 'PG').replace(/[^a-zA-Z0-9_-]/g, '_');
			const fileName = `PG_${safeName}_${character.localId}.json`;
			const driveMeta = await this.saveJsonFileToDrive(fileName, character, character.driveFileId);
			if (driveMeta && driveMeta.id && driveMeta.id !== character.driveFileId) {
				character.driveFileId = driveMeta.id;
				await this.saveLocalRecord('characters', character);
			}
		}

		return character;
	}

	async saveCampaignManifest(campaign) {
		if (!campaign.campaignId) {
			campaign.campaignId = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		campaign.updatedAt = Date.now();

		await this.saveLocalRecord('campaigns', campaign);

		if (this.accessToken && navigator.onLine && campaign.isMasterCopy !== false) {
			const safeName = (campaign.campaignName || 'Campagna').replace(/[^a-zA-Z0-9_-]/g, '_');
			const fileName = `CAMP_${safeName}_${campaign.campaignId}.json`;
			const driveMeta = await this.saveJsonFileToDrive(fileName, campaign, campaign.driveFileId);
			if (driveMeta && driveMeta.id) {
				campaign.driveFileId = driveMeta.id;
				await this.saveLocalRecord('campaigns', campaign);
			}
		}

		return campaign;
	}

	/**
	 * Per i giocatori (anche assenti alla sessione precedente):
	 * scarica dal Drive del Master la versione più recente del manifesto di campagna
	 * e aggiorna la cache locale.
	 */
	async refreshSharedCampaign(campaignId, masterDriveFileId) {
		if (!this.accessToken || !navigator.onLine || !masterDriveFileId) {
			return this.getLocalRecord('campaigns', campaignId);
		}
		const freshManifest = await this.readJsonFileFromDrive(masterDriveFileId);
		freshManifest.driveFileId = masterDriveFileId;
		freshManifest.isMasterCopy = false;
		await this.saveLocalRecord('campaigns', freshManifest);
		return freshManifest;
	}
}

export const driveService = new DriveStorageService();