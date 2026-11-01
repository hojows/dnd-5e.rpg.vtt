// js/drive-service.js
import {APP_CONFIG} from './config.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file email profile';
const SESSION_STORAGE_KEY = 'dnd5e_google_oauth_session_v2';
const LAST_EMAIL_STORAGE_KEY = 'dnd5e_google_last_email';
const ACTIVE_PC_CACHE_KEY = 'dnd5e_active_pc_working_copy';
const ACTIVE_CAMP_CACHE_KEY = 'dnd5e_active_campaign_working_copy';
const ACTIVE_IMAGES_IDB = 'DND5E_Active_Images_Cache';

class DriveStorageService {
	constructor() {
		this.accessToken = null;
		this.tokenClient = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		this.lastUserEmail = localStorage.getItem(LAST_EMAIL_STORAGE_KEY) || '';
		this.pickerApiLoaded = false;
		this.gisLoaded = false;
		this.authListeners = new Set();
		this.activeImagesMemory = {}; // uid -> base64 string (solo per il PG attivo)

		this.restoreSessionFromStorage();
	}

	// =========================================================================
	// 1. STORE SEPARATO PER LE IMMAGINI DEL SOLO PG ATTIVO
	// =========================================================================

	openImagesIdb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(ACTIVE_IMAGES_IDB, 1);
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains('images')) {
					db.createObjectStore('images');
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async saveActiveImagesMap(imagesMap) {
		this.activeImagesMemory = {...(imagesMap || {})};
		try {
			const db = await this.openImagesIdb();
			await new Promise((resolve, reject) => {
				const tx = db.transaction('images', 'readwrite');
				const store = tx.objectStore('images');
				store.clear();
				store.put(this.activeImagesMemory, 'active_pc_images');
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch (e) {
			console.warn('Impossibile salvare la cache immagini attiva:', e);
		}
	}

	async loadActiveImagesMap() {
		if (Object.keys(this.activeImagesMemory).length > 0) {
			return this.activeImagesMemory;
		}
		try {
			const db = await this.openImagesIdb();
			const map = await new Promise((resolve, reject) => {
				const tx = db.transaction('images', 'readonly');
				const req = tx.objectStore('images').get('active_pc_images');
				req.onsuccess = () => resolve(req.result || {});
				req.onerror = () => reject(req.error);
			});
			this.activeImagesMemory = map;
			return map;
		} catch (_) {
			return {};
		}
	}

	getImageDataUrl(uid) {
		if (!uid || !this.activeImagesMemory[uid]) return null;
		const raw = this.activeImagesMemory[uid];
		if (raw.startsWith('data:image')) return raw;
		return `data:image/jpeg;base64,${raw}`;
	}

	// =========================================================================
	// 2. CACHE LOCALE SOLO PER IL SINGOLO PG / CAMPAGNA ATTIVA (SENZA BASE64)
	// =========================================================================

	saveActiveCharacterWorkingCopy(character, isDirty = true) {
		if (!character) return;
		if (character._pendingImages && Object.keys(character._pendingImages).length > 0) {
			const merged = {...this.activeImagesMemory, ...character._pendingImages};
			delete character._pendingImages;
			this.saveActiveImagesMap(merged);
		}
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
	// 3. AUTENTICAZIONE GOOGLE OAUTH 2.0
	// =========================================================================

	restoreSessionFromStorage() {
		try {
			const saved = localStorage.getItem(SESSION_STORAGE_KEY);
			if (!saved) return;
			const parsed = JSON.parse(saved);
			if (parsed.expiresAt && Date.now() < parsed.expiresAt && parsed.accessToken) {
				this.accessToken = parsed.accessToken;
				this.userProfile = parsed.userProfile || null;
				this.vaultFolderId = parsed.vaultFolderId || null;
				if (this.userProfile?.email) {
					this.lastUserEmail = this.userProfile.email;
				}
			} else {
				localStorage.removeItem(SESSION_STORAGE_KEY);
			}
		} catch (_) {}
	}

	persistSessionToStorage(expiresInSec = 3500) {
		try {
			localStorage.setItem(
				SESSION_STORAGE_KEY,
				JSON.stringify({
					               accessToken: this.accessToken,
					               userProfile: this.userProfile,
					               vaultFolderId: this.vaultFolderId,
					               expiresAt: Date.now() + expiresInSec * 1000
				               })
			);
			if (this.userProfile?.email) {
				this.lastUserEmail = this.userProfile.email;
				localStorage.setItem(LAST_EMAIL_STORAGE_KEY, this.userProfile.email);
			}
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
			const clientConfig = {
				client_id: APP_CONFIG.GOOGLE_CLIENT_ID,
				scope: DRIVE_SCOPE,
				include_granted_scopes: true,
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
			};

			if (this.lastUserEmail) {
				clientConfig.hint = this.lastUserEmail;
			}

			this.tokenClient = window.google.accounts.oauth2.initTokenClient(clientConfig);
			this.tokenClient.requestAccessToken({prompt: ''});
		});
	}

	signOut() {
		this.accessToken = null;
		this.userProfile = null;
		this.vaultFolderId = null;
		localStorage.removeItem(SESSION_STORAGE_KEY);
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
	// 4. OPERAZIONI SU GOOGLE DRIVE API V3 (JSON + IMMAGINI SEPARATE)
	// =========================================================================

	async driveRequest(url, options = {}) {
		if (!this.accessToken) {
			throw new Error('Effettua prima il Login a Google Drive.');
		}
		const headers = {
			Authorization: `Bearer ${this.accessToken}`,
			...(options.headers || {})
		};
		const response = await fetch(url, {...options, headers});
		if (response.status === 401) {
			this.signOut();
			throw new Error('Sessione Google Drive scaduta. Clicca nuovamente su Login Google Drive.');
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

	/**
	 * Carica un'immagine Base64 su Google Drive come file binario JPEG separato
	 * (Content-Transfer-Encoding: base64), restituendo il relativo driveFileId.
	 */
	async saveImageFileToDrive(fileName, base64Data, existingDriveFileId = null) {
		const folderId = await this.ensureVaultFolder();
		const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '').replace(/\s+/g, '');
		const metadata = existingDriveFileId
		                 ? {name: fileName, mimeType: 'image/jpeg'}
		                 : {name: fileName, mimeType: 'image/jpeg', parents: [folderId]};

		const boundary = '-------dnd5e_vtt_img_boundary';
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		const multipartBody =
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			JSON.stringify(metadata) +
			delimiter +
			'Content-Type: image/jpeg\r\n' +
			'Content-Transfer-Encoding: base64\r\n\r\n' +
			cleanBase64 +
			closeDelimiter;

		const url = existingDriveFileId
		            ? `https://www.googleapis.com/upload/drive/v3/files/${existingDriveFileId}?uploadType=multipart&fields=id,name`
		            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;

		return this.driveRequest(url, {
			method: existingDriveFileId ? 'PATCH' : 'POST',
			headers: {'Content-Type': `multipart/related; boundary=${boundary}`},
			body: multipartBody
		});
	}

	/**
	 * Scarica un file immagine separato da Google Drive e lo converte in stringa Base64.
	 */
	async readImageBase64FromDrive(driveFileId) {
		if (!this.accessToken || !driveFileId) return null;
		const response = await fetch(
			`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
			{headers: {Authorization: `Bearer ${this.accessToken}`}}
		);
		if (!response.ok) return null;
		const blob = await response.blob();
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onloadend = () => {
				const res = String(reader.result || '');
				resolve(res.replace(/^data:image\/\w+;base64,/, ''));
			};
			reader.readAsDataURL(blob);
		});
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
		delete cleanData._pendingImages;

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
	// 5. CARICAMENTO E SALVATAGGIO PG (CON IMMAGINI SEPARATE SU DRIVE)
	// =========================================================================

	async listCharactersOnDrive() {
		if (!this.isAuthenticated()) return [];
		return this.listFilesInVault('PG_');
	}

	async loadCharacterFromDrive(driveFileId) {
		const ch = await this.readJsonFileFromDrive(driveFileId);
		ch.driveFileId = driveFileId;

		// Scarica le immagini separate collegate al PG (se presenti in imageDriveMap)
		const imgMap = {};
		if (ch.imageDriveMap && typeof ch.imageDriveMap === 'object') {
			await Promise.all(
				Object.entries(ch.imageDriveMap).map(async ([uid, imgFileId]) => {
					try {
						const b64 = await this.readImageBase64FromDrive(imgFileId);
						if (b64) imgMap[uid] = b64;
					} catch (_) {}
				})
			);
		}
		await this.saveActiveImagesMap(imgMap);
		this.saveActiveCharacterWorkingCopy(ch, false);
		return ch;
	}

	async saveCharacterToDrive(character) {
		if (!character.localId) {
			character.localId = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		}
		character.updatedAt = Date.now();

		if (!this.isAuthenticated()) {
			this.saveActiveCharacterWorkingCopy(character, true);
			throw new Error('Effettua prima il Login a Google Drive.');
		}

		// 1. Salva ogni immagine in cache come file .jpg separato su Google Drive
		const imagesMap = await this.loadActiveImagesMap();
		character.imageDriveMap = character.imageDriveMap || {};

		for (const [uid, base64Str] of Object.entries(imagesMap)) {
			if (!base64Str) continue;
			const existingImgDriveId = character.imageDriveMap[uid] || null;
			const imgFileName = `IMG_${character.localId}_${uid}.jpg`;
			const imgMeta = await this.saveImageFileToDrive(imgFileName, base64Str, existingImgDriveId);
			if (imgMeta && imgMeta.id) {
				character.imageDriveMap[uid] = imgMeta.id;
			}
		}

		// 2. Salva il file JSON leggero del personaggio (privo di stringhe Base64)
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
			throw new Error('Effettua prima il Login a Google Drive.');
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