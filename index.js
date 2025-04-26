/** @format */
const makeWASocket = require('baileys-pro').default;
const NodeCache = require('node-cache');
const conn = require('./lib/mongodb');
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });
const { initializeStore } = require('./lib/database/sql_init');
const { setupAd } = require('./lib/antidelete');
const {
	useMultiFileAuthState,
	DisconnectReason,
} = require('@im-dims/baileys-md');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const { serializeMessage } = require('./lib/serilize');
const { loadCommands, executeCommand } = require('./lib/cmd');
const handleMessage = require('./lib/handlemessage');

global.sock = null;

async function startWisteria() {
	console.log('initializing Database');
	await initializeStore();
	await conn();
	await loadCommands();

	const { state, saveCreds } = await useMultiFileAuthState('auth_info_nikka');
	sock = makeWASocket({
		auth: state,
		printQRInTerminal: true,
		browser: ['Nikka', 'Chrome', '1.0.0'],
		syncFullHistory: true,
		cachedGroupMetadata: async jid => groupCache.get(jid),
		markOnlineOnConnect: true,
		logger: pino({ level: 'silent' }),
	});
	global.store.bind(sock.ev);
	sock.ev.on('creds.update', saveCreds);

	sock.ev.on('messages.upsert', async m => {
		try {
			const msg = m.messages[0];
			if (m.type === 'notify') {
				const serialized = serializeMessage(msg, sock);
				if (serialized) {
					await handleMessage(serialized);
				}
			}
		} catch (err) {
			console.error('💔 Message processing error:', err);
		}
	});

	sock.ev.on('connection.update', async update => {
		const { connection, lastDisconnect, qr } = update;
		if (qr) qrcode.generate(qr, { small: true });

		if (connection === 'close') {
			const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
			switch (reason) {
				case DisconnectReason.badSession:
					console.log('❌ Bad session. Deleting and restarting...');
					fs.rmSync('auth_info_nikka', { recursive: true, force: true });
					startWisteria();
					break;
				case DisconnectReason.connectionClosed:
				case DisconnectReason.connectionLost:
					console.log('⚠️ Connection lost. Reconnecting...');
					startWisteria();
					break;
				case DisconnectReason.loggedOut:
					console.log('🔒 Logged out. Delete session and scan again.');
					break;
				default:
					console.log('🤷🏽‍♀️ Unknown disconnect. Reconnecting...');
					startWisteria();
			}
		}

		if (connection === 'open') {
			console.log('💖 Wisteria is connected 💖');
			let jid = sock.user.id;
			await sock.sendMessage(jid, {
				text: '💌 Connected',
			});
		}
	});
	sock.ev.on('messages.update', async updates => {
		try {
			const antideleteModule = await setupAd(sock, global.store);
			for (const update of updates) {
				if (
					update.update.message === null ||
					update.update.messageStubType === 2
				) {
					await antideleteModule.execute(sock, update, { store: global.store });
				}
			}
		} catch (error) {
			console.error('Error in message update handling:', error);
		}
	});

	sock.ev.on('groups.update', async ([event]) => {
		const metadata = await sock.groupMetadata(event.id);
		groupCache.set(event.id, metadata);
	});

	sock.ev.on('group-participants.update', async event => {
		const metadata = await sock.groupMetadata(event.id);
		groupCache.set(event.id, metadata);
	});
}

startWisteria();
