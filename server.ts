import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { getGlobalConnectionCount } from './connectionWrapper.js';
import { clientBlocked } from './limiter.js';
import { DELETE_EVENTS_AGE, getPlatformKey, streamEvents, requesterIdToLastRequestTimestamp, streamerIdToSocketsMap, socketToPlatformKeyMap, streamerIdToTikTokConnectionWrapperMap, streamerIdToTwitchClientMap, streamerIdToYouTubeConnectionMap, socketToPlatformMap, createInitialEventContainer } from './types.js';
import { getOrCreateTiktokConnectionWrapper } from './tiktok.js';
import { getOrCreateTwitchConnectionWrapper } from './twitch.js';
import { getOrCreateYouTubeConnectionWrapper, disconnectYouTube, updateYouTubeLastRequest } from './youtube.js';

const app = express();
const httpServer = createServer(app);

// Enable cross origin resource sharing
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    const setTikTokStreamerId = (streamerId: string, options: any) => {
        if (typeof options === 'object' && options) {
            delete options.requestOptions;
            delete options.websocketOptions;
        } else {
            options = {};
        }

        if (process.env.SESSIONID) {
            options.sessionId = process.env.SESSIONID;
            console.info('Using SessionId');
        }

        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TikTok.');
            return;
        }

        const platformKey = getPlatformKey('tiktok', streamerId);

        let socketList: any[];
        if (streamerIdToSocketsMap[platformKey]) {
            socketList = streamerIdToSocketsMap[platformKey];
        } else {
            socketList = [];
            streamerIdToSocketsMap[platformKey] = socketList;
        }

        const [tiktokConnectionWrapper, errStr] = getOrCreateTiktokConnectionWrapper(platformKey, streamerId, options);

        if (tiktokConnectionWrapper) {
            socketList.push(socket);
            socketToPlatformKeyMap[socket.id] = platformKey;
            socketToPlatformMap[socket.id] = 'tiktok';
        } else {
            socket.emit('streamDisconnected', { platform: 'tiktok', reason: errStr });
            return;
        }
    };

    const setTwitchStreamerId = async (streamerId: string, options: any) => {
        if (typeof options !== 'object' || !options) {
            options = {};
        }

        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('streamDisconnected', { platform: 'twitch', reason: 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance.' });
            return;
        }

        const platformKey = getPlatformKey('twitch', streamerId);

        let socketList: any[];
        if (streamerIdToSocketsMap[platformKey]) {
            socketList = streamerIdToSocketsMap[platformKey];
        } else {
            socketList = [];
            streamerIdToSocketsMap[platformKey] = socketList;
        }

        const [twitchClient, errStr] = await getOrCreateTwitchConnectionWrapper(platformKey, streamerId, options);

        if (twitchClient) {
            socketList.push(socket);
            socketToPlatformKeyMap[socket.id] = platformKey;
            socketToPlatformMap[socket.id] = 'twitch';
        } else {
            socket.emit('streamDisconnected', { platform: 'twitch', reason: errStr });
            return;
        }
    };

    const setYouTubeStreamerId = async (streamerId: string, options: any) => {
        if (typeof options !== 'object' || !options) {
            options = {};
        }

        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('streamDisconnected', { platform: 'youtube', reason: 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance.' });
            return;
        }

        const platformKey = getPlatformKey('youtube', streamerId);

        let socketList: any[];
        if (streamerIdToSocketsMap[platformKey]) {
            socketList = streamerIdToSocketsMap[platformKey];
        } else {
            socketList = [];
            streamerIdToSocketsMap[platformKey] = socketList;
        }

        const [youTubeConnection, errStr] = await getOrCreateYouTubeConnectionWrapper(platformKey, streamerId, options);

        if (youTubeConnection) {
            socketList.push(socket);
            socketToPlatformKeyMap[socket.id] = platformKey;
            socketToPlatformMap[socket.id] = 'youtube';
        } else {
            socket.emit('streamDisconnected', { platform: 'youtube', reason: errStr });
            return;
        }
    };

    socket.on('setUniqueId', setTikTokStreamerId);
    socket.on('setstreamerId', setTikTokStreamerId);
    socket.on('setTwitchStreamerId', setTwitchStreamerId);
    socket.on('setYouTubeStreamerId', setYouTubeStreamerId);

    socket.on('disconnect', () => {
        const platformKey = socketToPlatformKeyMap[socket.id];

        if (platformKey && streamerIdToSocketsMap[platformKey]) {
            const socketList = streamerIdToSocketsMap[platformKey];
            const socketIndex = socketList.indexOf(socket);

            if (socketIndex > -1) {
                socketList.splice(socketIndex, 1);
            }

            delete socketToPlatformKeyMap[socket.id];
            delete socketToPlatformMap[socket.id];

            // Clean up if no more sockets
            if (socketList.length === 0) {
                // Check platform based on key prefix
                if (platformKey.startsWith('tiktok:')) {
                    const wrapper = streamerIdToTikTokConnectionWrapperMap[platformKey];
                    if (wrapper) {
                        wrapper.disconnect();
                        streamerIdToTikTokConnectionWrapperMap[platformKey] = undefined;
                    }
                } else if (platformKey.startsWith('twitch:')) {
                    const client = streamerIdToTwitchClientMap[platformKey];
                    if (client) {
                        client.disconnect();
                        streamerIdToTwitchClientMap[platformKey] = undefined;
                    }
                } else if (platformKey.startsWith('youtube:')) {
                    disconnectYouTube(platformKey);
                }
            }
        }
    });
});

app.get('/events', (req, res) => {
    const { streamerId, requesterId, platform } = req.query;

    if (typeof streamerId !== 'string') {
        return res.status(400).send('Missing streamerId parameter.');
    }

    if (typeof requesterId !== 'string') {
        return res.status(400).send('Missing requesterId parameter.');
    }

    const platformType = (typeof platform === 'string' ? platform.toLowerCase() : 'tiktok') as 'tiktok' | 'twitch' | 'youtube';
    const platformKey = getPlatformKey(platformType, streamerId);
    const options = { /*enableExtendedGiftInfo: true*/ };

    if (platformType === 'youtube') {
        // Update last request timestamp for YouTube polling
        updateYouTubeLastRequest(platformKey);

        // Ensure connection exists
        if (!streamerIdToYouTubeConnectionMap[platformKey]?.isConnected) {
            getOrCreateYouTubeConnectionWrapper(platformKey, streamerId, options);
        }

        if (!streamEvents[platformKey]) {
            streamEvents[platformKey] = createInitialEventContainer();
        }

        const lastRequestTimestamp = requesterIdToLastRequestTimestamp[requesterId];
        if (!lastRequestTimestamp) {
            requesterIdToLastRequestTimestamp[requesterId] = Date.now();
            return res.json({ events: [], message: 'New ID registered. No events yet.' });
        }

        const { events } = streamEvents[platformKey];
        const newEvents = events.filter(event => event.timestamp > lastRequestTimestamp);

        requesterIdToLastRequestTimestamp[requesterId] = Date.now();
        streamEvents[platformKey].events = streamEvents[platformKey].events.filter(
            event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE)
        );

        res.json({ events: newEvents.map(event => ({ platform: 'youtube', type: event.type, data: event.data })) });
    } else if (platformType === 'twitch') {
        // Ensure connection exists
        if (!streamerIdToTwitchClientMap[platformKey]) {
            getOrCreateTwitchConnectionWrapper(platformKey, streamerId, options);
        }

        if (!streamEvents[platformKey]) {
            streamEvents[platformKey] = createInitialEventContainer();
        }

        const lastRequestTimestamp = requesterIdToLastRequestTimestamp[requesterId];
        if (!lastRequestTimestamp) {
            requesterIdToLastRequestTimestamp[requesterId] = Date.now();
            return res.json({ events: [], message: 'New ID registered. No events yet.' });
        }

        const { events } = streamEvents[platformKey];
        const newEvents = events.filter(event => event.timestamp > lastRequestTimestamp);

        requesterIdToLastRequestTimestamp[requesterId] = Date.now();
        streamEvents[platformKey].events = streamEvents[platformKey].events.filter(
            event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE)
        );

        res.json({ events: newEvents.map(event => ({ platform: 'twitch', type: event.type, data: event.data })) });
    } else {
        // TikTok logic
        const [tiktokConnectionWrapper, errStr] = getOrCreateTiktokConnectionWrapper(platformKey, streamerId, options);

        if (errStr) {
            return res.json({ events: [], message: errStr });
        }

        if (!streamEvents[platformKey]) {
            streamEvents[platformKey] = createInitialEventContainer();
        }

        const lastRequestTimestamp = requesterIdToLastRequestTimestamp[requesterId];
        if (!lastRequestTimestamp) {
            requesterIdToLastRequestTimestamp[requesterId] = Date.now();
            return res.json({ events: [], message: 'New ID registered. No events yet.' });
        }

        const { events } = streamEvents[platformKey];
        const newEvents = events.filter(event => event.timestamp > lastRequestTimestamp);

        requesterIdToLastRequestTimestamp[requesterId] = Date.now();
        streamEvents[platformKey].events = streamEvents[platformKey].events.filter(
            event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE)
        );

        res.json({ events: newEvents.map(event => ({ platform: 'tiktok', type: event.type, data: event.data, timestamp: event.timestamp })) });
    }
});

setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000);

app.use(express.static('public'));

const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);
