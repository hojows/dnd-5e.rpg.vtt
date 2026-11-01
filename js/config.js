export const APP_CONFIG = {
	GOOGLE_CLIENT_ID: '877024851125-nekkss6jois626hq4v4a529nb3jdtclr.apps.googleusercontent.com',
	GOOGLE_API_KEY: 'AIzaSyDsoUVsMU6RrylDdQnFohJcJ_W61fba1Gg',

	DRIVE_VAULT_FOLDER: 'DND_5E_RPG_VTT',

	DB: {
		MANIFEST_URL: './data/db-manifest.json',
		IDB_NAME: 'DND5E_Compendium_Cache_v2',
		IDB_STORE: 'sqlite_packs',
		SQLJS_WASM_CDN: 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/'
	},

	WEBRTC: {
		ICE_SERVERS: [
			{urls: 'stun:stun.l.google.com:19302'},
			{urls: 'stun:stun1.l.google.com:19302'}
		]
	}
};