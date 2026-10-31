// js/p2p-service.js
import {APP_CONFIG} from './config.js';

class P2PRealtimeService {
	constructor() {
		this.peer = null;
		this.role = null; // "gm" | "pc"
		this.roomId = null;
		this.hostConnection = null; // Usato dal PC per parlare col GM
		this.clientConnections = new Map(); // Usato dal GM: peerId -> DataConnection
		this.eventListeners = new Map();
		this.heartbeatTimer = null;
	}

	on(eventName, callback) {
		if (!this.eventListeners.has(eventName)) {
			this.eventListeners.set(eventName, new Set());
		}
		this.eventListeners.get(eventName).add(callback);
		return () => this.eventListeners.get(eventName)?.delete(callback);
	}

	emit(eventName, payload) {
		const callbacks = this.eventListeners.get(eventName);
		if (!callbacks) return;
		for (const cb of callbacks) {
			cb(payload);
		}
	}

	buildDeterministicPeerId(campaignId) {
		const clean = String(campaignId || 'default')
			.replace(/[^a-zA-Z0-9_-]/g, '-')
			.toLowerCase();
		return `dnd5e-vtt-host-${clean}`;
	}

	disconnect() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.hostConnection) {
			try { this.hostConnection.close(); } catch (_) {}
			this.hostConnection = null;
		}
		for (const conn of this.clientConnections.values()) {
			try { conn.close(); } catch (_) {}
		}
		this.clientConnections.clear();
		if (this.peer) {
			try { this.peer.destroy(); } catch (_) {}
			this.peer = null;
		}
		this.emit('STATUS_CHANGE', {status: 'disconnected', role: this.role});
	}

	// =========================================================================
	// MODALITÀ MASTER (HOST DELLA STANZA P2P)
	// =========================================================================

	startAsMasterHost(campaignId) {
		this.disconnect();
		this.role = 'gm';
		this.roomId = this.buildDeterministicPeerId(campaignId);

		if (typeof window.Peer === 'undefined') {
			throw new Error('Libreria PeerJS non caricata nella pagina.');
		}

		this.peer = new window.Peer(this.roomId, {
			config: {iceServers: APP_CONFIG.WEBRTC.ICE_SERVERS}
		});

		this.peer.on('open', (id) => {
			this.emit('STATUS_CHANGE', {status: 'hosting', peerId: id, roomId: this.roomId});
		});

		this.peer.on('connection', (conn) => {
			conn.on('open', () => {
				this.clientConnections.set(conn.peer, conn);
				this.emit('PEER_CONNECTED', {peerId: conn.peer});
			});

			conn.on('data', (msg) => {
				this.handleIncomingMessageOnMaster(conn, msg);
			});

			conn.on('close', () => {
				this.clientConnections.delete(conn.peer);
				this.emit('PEER_DISCONNECTED', {peerId: conn.peer});
			});

			conn.on('error', (err) => {
				this.emit('ERROR', {peerId: conn.peer, error: err.message || String(err)});
			});
		});

		this.peer.on('error', (err) => {
			this.emit('ERROR', {error: err.message || String(err)});
		});
	}

	handleIncomingMessageOnMaster(conn, msg) {
		if (!msg || !msg.type) return;

		switch (msg.type) {
			case 'PING':
				conn.send({type: 'PONG', timestamp: Date.now()});
				break;
			case 'PLAYER_HELLO':
				this.emit('PLAYER_JOINED', {
					peerId: conn.peer,
					playerEmail: msg.playerEmail,
					character: msg.character,
					downtimeLog: msg.downtimeLog || []
				});
				break;
			case 'CHARACTER_SYNC':
				this.emit('CHARACTER_UPDATED', {
					peerId: conn.peer,
					character: msg.character,
					reason: msg.reason || 'update'
				});
				// Propaga lo stato aggiornato anche agli altri membri del party
				this.broadcastFromMaster(
					{type: 'PARTY_MEMBER_UPDATE', characterSummary: this.extractSummary(msg.character)},
					conn.peer
				);
				break;
			case 'DICE_ROLL':
				this.emit('DICE_ROLLED', msg.rollEntry);
				this.broadcastFromMaster({type: 'DICE_ROLL', rollEntry: msg.rollEntry}, conn.peer);
				break;
			case 'APPROVAL_REQUEST':
				this.emit('APPROVAL_REQUESTED', {
					peerId: conn.peer,
					requestId: msg.requestId,
					characterId: msg.characterId,
					characterName: msg.characterName,
					requestType: msg.requestType,
					payload: msg.payload
				});
				break;
			default:
				this.emit('CUSTOM_MESSAGE', {peerId: conn.peer, msg});
		}
	}

	broadcastFromMaster(messageObj, excludePeerId = null) {
		for (const [peerId, conn] of this.clientConnections.entries()) {
			if (peerId !== excludePeerId && conn.open) {
				conn.send(messageObj);
			}
		}
	}

	sendToPlayer(peerId, messageObj) {
		const conn = this.clientConnections.get(peerId);
		if (conn && conn.open) {
			conn.send(messageObj);
		}
	}

	/**
	 * Il Master invia in push l'intero manifesto di campagna (Negozio, Livello Max,
	 * Ricompense, Elementi Custom) a tutti i giocatori connessi.
	 */
	pushCampaignUpdateToParty(campaignManifest) {
		this.broadcastFromMaster({
			                         type: 'CAMPAIGN_PUSH',
			                         campaign: campaignManifest,
			                         timestamp: Date.now()
		                         });
	}

	// =========================================================================
	// MODALITÀ GIOCATORE (CLIENT CONNESSO ALLA STANZA DEL MASTER)
	// =========================================================================

	connectAsPlayerClient(campaignId, initialHandshakePayload) {
		this.disconnect();
		this.role = 'pc';
		this.roomId = this.buildDeterministicPeerId(campaignId);

		if (typeof window.Peer === 'undefined') {
			throw new Error('Libreria PeerJS non caricata nella pagina.');
		}

		this.peer = new window.Peer({
			                            config: {iceServers: APP_CONFIG.WEBRTC.ICE_SERVERS}
		                            });

		this.peer.on('open', () => {
			this.emit('STATUS_CHANGE', {status: 'connecting', roomId: this.roomId});
			const conn = this.peer.connect(this.roomId, {reliable: true});
			this.hostConnection = conn;

			conn.on('open', () => {
				this.emit('STATUS_CHANGE', {status: 'connected', roomId: this.roomId});
				conn.send({
					          type: 'PLAYER_HELLO',
					          playerEmail: initialHandshakePayload.playerEmail || null,
					          character: initialHandshakePayload.character,
					          downtimeLog: initialHandshakePayload.character?.downtimeLog || []
				          });
				this.startClientHeartbeat();
			});

			conn.on('data', (msg) => {
				this.handleIncomingMessageOnPlayer(msg);
			});

			conn.on('close', () => {
				this.emit('STATUS_CHANGE', {status: 'disconnected', roomId: this.roomId});
			});

			conn.on('error', (err) => {
				this.emit('ERROR', {error: err.message || String(err)});
			});
		});

		this.peer.on('error', (err) => {
			this.emit('ERROR', {error: err.message || String(err)});
		});
	}

	startClientHeartbeat() {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (this.hostConnection && this.hostConnection.open) {
				this.hostConnection.send({type: 'PING', timestamp: Date.now()});
			}
		}, 15000);
	}

	handleIncomingMessageOnPlayer(msg) {
		if (!msg || !msg.type) return;

		switch (msg.type) {
			case 'CAMPAIGN_PUSH':
				this.emit('CAMPAIGN_RECEIVED', msg.campaign);
				break;
			case 'GM_CHARACTER_OVERRIDE':
				this.emit('GM_OVERRIDE_RECEIVED', msg.patch);
				break;
			case 'DICE_ROLL':
				this.emit('DICE_ROLLED', msg.rollEntry);
				break;
			case 'APPROVAL_RESPONSE':
				this.emit('APPROVAL_RESOLVED', msg);
				break;
			case 'PARTY_MEMBER_UPDATE':
				this.emit('PARTY_UPDATED', msg.characterSummary);
				break;
			default:
				this.emit('CUSTOM_MESSAGE', msg);
		}
	}

	sendCharacterUpdateToMaster(character, reason = 'sheet_change') {
		if (this.hostConnection && this.hostConnection.open) {
			this.hostConnection.send({
				                         type: 'CHARACTER_SYNC',
				                         character,
				                         reason,
				                         timestamp: Date.now()
			                         });
		}
	}

	sendDiceRoll(rollEntry) {
		if (this.role === 'gm') {
			this.broadcastFromMaster({type: 'DICE_ROLL', rollEntry});
		} else if (this.hostConnection && this.hostConnection.open) {
			this.hostConnection.send({type: 'DICE_ROLL', rollEntry});
		}
	}

	requestMasterApproval(character, requestType, payload) {
		if (!this.hostConnection || !this.hostConnection.open) {
			throw new Error('Impossibile inviare la richiesta: il Master non è connesso in P2P.');
		}
		const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		this.hostConnection.send({
			                         type: 'APPROVAL_REQUEST',
			                         requestId,
			                         characterId: character.localId,
			                         characterName: character.name,
			                         requestType,
			                         payload
		                         });
		return requestId;
	}

	extractSummary(character) {
		if (!character) return null;
		return {
			localId: character.localId,
			name: character.name,
			level: character.level,
			race: character.race,
			classesRaw: character.classesRaw,
			hp: character.hp,
			conditions: character.conditions || []
		};
	}
}

export const p2pService = new P2PRealtimeService();