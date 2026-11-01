// js/p2p-service.js
import {APP_CONFIG} from './config.js';

class P2PRealtimeService {
	constructor() {
		this.peer = null;
		this.role = null; // "gm" | "pc"
		this.roomId = null;
		this.status = 'disconnected'; // "disconnected" | "connecting" | "connected" | "hosting"
		this.hostConnection = null;
		this.clientConnections = new Map(); // peerId -> DataConnection
		this.eventListeners = new Map();
		this.heartbeatTimer = null;
		this.monitorTimer = null;
		this.isProbing = false;
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

	// =========================================================================
	// MONITORAGGIO STATO SESSIONE (VERIFICA SE IL MASTER È ONLINE)
	// =========================================================================

	/**
	 * Verifica silenziosamente se la stanza P2P del Master per la campagna specificata è attiva.
	 */
	probeMasterSession(campaignId) {
		if (!campaignId || typeof window.Peer === 'undefined' || !navigator.onLine) {
			return Promise.resolve(false);
		}
		if (this.status === 'connected' || this.status === 'connecting') {
			return Promise.resolve(true);
		}
		if (this.isProbing) {
			return Promise.resolve(null);
		}

		this.isProbing = true;
		const targetRoomId = this.buildDeterministicPeerId(campaignId);

		return new Promise((resolve) => {
			let settled = false;
			let tempPeer = null;

			const finish = (isAvailable) => {
				if (settled) return;
				settled = true;
				this.isProbing = false;
				if (tempPeer) {
					try { tempPeer.destroy(); } catch (_) {}
				}
				resolve(isAvailable);
			};

			const timeout = setTimeout(() => finish(false), 3500);

			try {
				tempPeer = new window.Peer({
					                           config: {iceServers: APP_CONFIG.WEBRTC.ICE_SERVERS}
				                           });

				tempPeer.on('open', () => {
					const probeConn = tempPeer.connect(targetRoomId, {
						reliable: true,
						metadata: {probe: true}
					});

					probeConn.on('open', () => {
						clearTimeout(timeout);
						try { probeConn.close(); } catch (_) {}
						finish(true);
					});

					probeConn.on('error', () => {
						clearTimeout(timeout);
						finish(false);
					});
				});

				tempPeer.on('error', () => {
					clearTimeout(timeout);
					finish(false);
				});
			} catch (_) {
				clearTimeout(timeout);
				finish(false);
			}
		});
	}

	/**
	 * Avvia il controllo periodico dello stato della sessione del Master per il PG associato alla campagna.
	 */
	startSessionMonitor(campaignId, intervalMs = 8000) {
		this.stopSessionMonitor();
		if (!campaignId) return;

		const runCheck = async () => {
			if (this.status === 'connected' || this.status === 'connecting') return;
			const available = await this.probeMasterSession(campaignId);
			if (available !== null) {
				this.emit('SESSION_AVAILABILITY', {campaignId, available});
			}
		};

		runCheck();
		this.monitorTimer = setInterval(runCheck, intervalMs);
	}

	stopSessionMonitor() {
		if (this.monitorTimer) {
			clearInterval(this.monitorTimer);
			this.monitorTimer = null;
		}
	}

	// =========================================================================
	// MODALITÀ MASTER (AVVIO E CHIUSURA STANZA LIVE)
	// =========================================================================

	startAsMasterHost(campaignId) {
		this.stopMasterHost(false);
		this.role = 'gm';
		this.roomId = this.buildDeterministicPeerId(campaignId);

		if (typeof window.Peer === 'undefined') {
			throw new Error('Libreria PeerJS non caricata nella pagina.');
		}

		this.status = 'connecting';
		this.emit('STATUS_CHANGE', {
			status: 'connecting',
			role: 'gm',
			roomId: this.roomId,
			connectedCount: 0
		});

		this.peer = new window.Peer(this.roomId, {
			config: {iceServers: APP_CONFIG.WEBRTC.ICE_SERVERS}
		});

		this.peer.on('open', (id) => {
			this.status = 'hosting';
			this.emit('STATUS_CHANGE', {
				status: 'hosting',
				role: 'gm',
				peerId: id,
				roomId: this.roomId,
				connectedCount: this.clientConnections.size
			});
		});

		this.peer.on('connection', (conn) => {
			// Se è solo un probe automatico di verifica stato sessione, non aggiungerlo al party
			if (conn.metadata && conn.metadata.probe) {
				conn.on('open', () => {
					conn.send({type: 'PROBE_ACK'});
					setTimeout(() => {
						try { conn.close(); } catch (_) {}
					}, 150);
				});
				return;
			}

			conn.on('open', () => {
				this.clientConnections.set(conn.peer, conn);
				this.emit('PEER_CONNECTED', {
					peerId: conn.peer,
					connectedCount: this.clientConnections.size
				});
				this.emit('STATUS_CHANGE', {
					status: 'hosting',
					role: 'gm',
					roomId: this.roomId,
					connectedCount: this.clientConnections.size
				});
			});

			conn.on('data', (msg) => {
				this.handleIncomingMessageOnMaster(conn, msg);
			});

			conn.on('close', () => {
				this.clientConnections.delete(conn.peer);
				this.emit('PEER_DISCONNECTED', {
					peerId: conn.peer,
					connectedCount: this.clientConnections.size
				});
				this.emit('STATUS_CHANGE', {
					status: 'hosting',
					role: 'gm',
					roomId: this.roomId,
					connectedCount: this.clientConnections.size
				});
			});

			conn.on('error', (err) => {
				this.emit('ERROR', {peerId: conn.peer, error: err.message || String(err)});
			});
		});

		this.peer.on('error', (err) => {
			this.status = 'disconnected';
			this.emit('STATUS_CHANGE', {status: 'disconnected', role: 'gm', connectedCount: 0});
			this.emit('ERROR', {error: err.message || String(err)});
		});
	}

	/**
	 * Chiude la sessione live del Master e notifica tutti i giocatori connessi.
	 */
	stopMasterHost(notifyPlayers = true) {
		if (notifyPlayers && this.clientConnections.size > 0) {
			this.broadcastFromMaster({
				                         type: 'SESSION_CLOSED',
				                         timestamp: Date.now()
			                         });
		}
		for (const conn of this.clientConnections.values()) {
			try { conn.close(); } catch (_) {}
		}
		this.clientConnections.clear();

		if (this.peer) {
			try { this.peer.destroy(); } catch (_) {}
			this.peer = null;
		}

		this.status = 'disconnected';
		this.emit('STATUS_CHANGE', {
			status: 'disconnected',
			role: 'gm',
			connectedCount: 0
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
				this.broadcastFromMaster(
					{type: 'PARTY_MEMBER_UPDATE', characterSummary: this.extractSummary(msg.character)},
					conn.peer
				);
				break;
			case 'PLAYER_LEFT':
				this.clientConnections.delete(conn.peer);
				this.emit('PEER_DISCONNECTED', {
					peerId: conn.peer,
					characterId: msg.characterId,
					connectedCount: this.clientConnections.size
				});
				this.emit('STATUS_CHANGE', {
					status: 'hosting',
					role: 'gm',
					roomId: this.roomId,
					connectedCount: this.clientConnections.size
				});
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

	pushCampaignUpdateToParty(campaignManifest) {
		this.broadcastFromMaster({
			                         type: 'CAMPAIGN_PUSH',
			                         campaign: campaignManifest,
			                         timestamp: Date.now()
		                         });
	}

	// =========================================================================
	// MODALITÀ GIOCATORE (CONNESSIONE E DISCONNESSIONE SESSIONE CAMPAGNA)
	// =========================================================================

	connectAsPlayerClient(campaignId, initialHandshakePayload) {
		if (!campaignId) {
			throw new Error('Il personaggio non è associato a nessuna campagna.');
		}

		this.disconnectPlayerClient(false);
		this.role = 'pc';
		this.roomId = this.buildDeterministicPeerId(campaignId);

		if (typeof window.Peer === 'undefined') {
			throw new Error('Libreria PeerJS non caricata nella pagina.');
		}

		this.status = 'connecting';
		this.emit('STATUS_CHANGE', {status: 'connecting', role: 'pc', roomId: this.roomId});

		this.peer = new window.Peer({
			                            config: {iceServers: APP_CONFIG.WEBRTC.ICE_SERVERS}
		                            });

		this.peer.on('open', () => {
			const conn = this.peer.connect(this.roomId, {reliable: true});
			this.hostConnection = conn;

			conn.on('open', () => {
				this.status = 'connected';
				this.emit('STATUS_CHANGE', {status: 'connected', role: 'pc', roomId: this.roomId});
				conn.send({
					          type: 'PLAYER_HELLO',
					          playerEmail: initialHandshakePayload.playerEmail || null,
					          character: JSON.parse(JSON.stringify(initialHandshakePayload.character)),
					          downtimeLog: initialHandshakePayload.character?.downtimeLog || []
				          });
				this.startClientHeartbeat();
			});

			conn.on('data', (msg) => {
				this.handleIncomingMessageOnPlayer(msg);
			});

			conn.on('close', () => {
				this.status = 'disconnected';
				this.emit('STATUS_CHANGE', {status: 'disconnected', role: 'pc', roomId: this.roomId});
				this.emit('SESSION_AVAILABILITY', {campaignId, available: false});
			});

			conn.on('error', (err) => {
				this.status = 'disconnected';
				this.emit('STATUS_CHANGE', {status: 'disconnected', role: 'pc', roomId: this.roomId});
				this.emit('ERROR', {error: err.message || String(err)});
			});
		});

		this.peer.on('error', (err) => {
			this.status = 'disconnected';
			this.emit('STATUS_CHANGE', {status: 'disconnected', role: 'pc', roomId: this.roomId});
			this.emit('SESSION_AVAILABILITY', {campaignId, available: false});
			this.emit('ERROR', {
				error:
					err.type === 'peer-unavailable'
					? 'La sessione del Master non è attualmente attiva.'
					: err.message || String(err)
			});
		});
	}

	/**
	 * Disconnette il giocatore dalla sessione live del Master.
	 */
	disconnectPlayerClient(notifyMaster = true, characterId = null) {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (notifyMaster && this.hostConnection && this.hostConnection.open) {
			try {
				this.hostConnection.send({
					                         type: 'PLAYER_LEFT',
					                         characterId,
					                         timestamp: Date.now()
				                         });
			} catch (_) {}
		}

		if (this.hostConnection) {
			try { this.hostConnection.close(); } catch (_) {}
			this.hostConnection = null;
		}

		if (this.peer) {
			try { this.peer.destroy(); } catch (_) {}
			this.peer = null;
		}

		this.status = 'disconnected';
		this.emit('STATUS_CHANGE', {status: 'disconnected', role: 'pc', roomId: this.roomId});
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
			case 'SESSION_CLOSED':
				this.disconnectPlayerClient(false);
				this.emit('SESSION_CLOSED_BY_MASTER', {});
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
		if (this.hostConnection && this.hostConnection.open && character) {
			this.hostConnection.send({
				                         type: 'CHARACTER_SYNC',
				                         character: JSON.parse(JSON.stringify(character)),
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