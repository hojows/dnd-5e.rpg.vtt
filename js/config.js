// js/config.js

export const APP_CONFIG = {
	GOOGLE_CLIENT_ID: '877024851125-nekkss6jois626hq4v4a529nb3jdtclr.apps.googleusercontent.com',
	GOOGLE_API_KEY: 'AIzaSyDsoUVsMU6RrylDdQnFohJcJ_W61fba1Gg',

	DRIVE_VAULT_FOLDER: 'DND5E_Vault',

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

export const CORE_ABILITIES = [
	{key: 'str', index: 0, label_ita: 'FOR', label_eng: 'STR', full_ita: 'Forza', full_eng: 'Strength'},
	{key: 'dex', index: 1, label_ita: 'DES', label_eng: 'DEX', full_ita: 'Destrezza', full_eng: 'Dexterity'},
	{key: 'con', index: 2, label_ita: 'COS', label_eng: 'CON', full_ita: 'Costituzione', full_eng: 'Constitution'},
	{key: 'int', index: 3, label_ita: 'INT', label_eng: 'INT', full_ita: 'Intelligenza', full_eng: 'Intelligence'},
	{key: 'wis', index: 4, label_ita: 'SAG', label_eng: 'WIS', full_ita: 'Saggezza', full_eng: 'Wisdom'},
	{key: 'cha', index: 5, label_ita: 'CAR', label_eng: 'CHA', full_ita: 'Carisma', full_eng: 'Charisma'}
];

export const CORE_SKILLS = [
	{code: 100, monsterId: 0, key: 'Acrobatics', label_ita: 'Acrobazia', label_eng: 'Acrobatics', ability: 'dex'},
	{code: 101, monsterId: 1, key: 'Animal Handling', label_ita: 'Addestrare Animali', label_eng: 'Animal Handling', ability: 'wis'},
	{code: 102, monsterId: 2, key: 'Arcana', label_ita: 'Arcano', label_eng: 'Arcana', ability: 'int'},
	{code: 103, monsterId: 3, key: 'Athletics', label_ita: 'Atletica', label_eng: 'Athletics', ability: 'str'},
	{code: 104, monsterId: 4, key: 'Deception', label_ita: 'Inganno', label_eng: 'Deception', ability: 'cha'},
	{code: 105, monsterId: 5, key: 'History', label_ita: 'Storia', label_eng: 'History', ability: 'int'},
	{code: 106, monsterId: 6, key: 'Insight', label_ita: 'Intuizione', label_eng: 'Insight', ability: 'wis'},
	{code: 107, monsterId: 7, key: 'Intimidation', label_ita: 'Intimidire', label_eng: 'Intimidation', ability: 'cha'},
	{code: 108, monsterId: 8, key: 'Investigation', label_ita: 'Indagare', label_eng: 'Investigation', ability: 'int'},
	{code: 109, monsterId: 9, key: 'Medicine', label_ita: 'Medicina', label_eng: 'Medicine', ability: 'wis'},
	{code: 110, monsterId: 10, key: 'Nature', label_ita: 'Natura', label_eng: 'Nature', ability: 'int'},
	{code: 111, monsterId: 11, key: 'Perception', label_ita: 'Percezione', label_eng: 'Perception', ability: 'wis'},
	{code: 112, monsterId: 12, key: 'Performance', label_ita: 'Intrattenere', label_eng: 'Performance', ability: 'cha'},
	{code: 113, monsterId: 13, key: 'Persuasion', label_ita: 'Persuasione', label_eng: 'Persuasion', ability: 'cha'},
	{code: 114, monsterId: 14, key: 'Religion', label_ita: 'Religione', label_eng: 'Religion', ability: 'int'},
	{code: 115, monsterId: 15, key: 'Sleight of Hand', label_ita: 'Rapidità di Mano', label_eng: 'Sleight of Hand', ability: 'dex'},
	{code: 116, monsterId: 16, key: 'Stealth', label_ita: 'Furtività', label_eng: 'Stealth', ability: 'dex'},
	{code: 117, monsterId: 17, key: 'Survival', label_ita: 'Sopravvivenza', label_eng: 'Survival', ability: 'wis'}
];