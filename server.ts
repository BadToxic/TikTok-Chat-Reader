import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokConnectionWrapper, getGlobalConnectionCount } from './connectionWrapper.js';
import { clientBlocked } from './limiter.js';
import tmi from 'tmi.js';
import type { StreamEvent, StreamEvents, UserBaseData } from './events.model.js';

const app = express();
const httpServer = createServer(app);

// Keep events for 30 minutes
const DELETE_EVENTS_AGE = 30 * 60 * 1000;

// All known TikTok events: ['roomUser', 'member', 'chat', 'gift', 'social', 'like', 'questionNew', 'linkMicBattle', 'linkMicArmies', 'liveIntro', 'emote', 'envelope', 'subscribe', 'streamEnd', 'superFan'];
const tiktokEventTypesToStore = ['liveIntro', 'member', 'roomUser', 'chat', 'gift', 'like', 'follow', 'share', 'emote', 'envelope', 'subscribe', 'superFan', 'streamEnd'];

// Platform spezific Key
const getPlatformKey = (platform: 'tiktok' | 'twitch', streamerId: string): string => {
    return `${platform}:${streamerId.toLowerCase()}`;
};

const tiktokUserBaseData = (data: any): UserBaseData => {
    let profilePictureUrl: string = '';
    const rawUrl = data.profilePictureUrl ? data.profilePictureUrl : data.profilePicture?.url;
    if (Array.isArray(rawUrl)) {
        profilePictureUrl = rawUrl.length > 0 ? rawUrl[0] : '';
    } else if (typeof rawUrl === 'string') {
        profilePictureUrl = rawUrl;
    }
    return {
        userId: data.userId,
        uniqueId: data.uniqueId,
        nickname: data.nickname,
        profilePictureUrl,
    };
};

const twitchUserBaseData = (username: string, tags: tmi.ChatUserstate): UserBaseData => {
    return {
        userId: tags['user-id'] || username,
        uniqueId: tags['display-name'] || username, // The "display-name" will always be the same as the username, but have another casing
        // profilePictureUrl: '',
    };
};

function isPendingStreak(data: any): boolean {
    return data.giftType === 1 && !data.repeatEnd;
}

const tiktokEventTypeToTransformer: { [key: string]: (data: any) => StreamEvent } = {
    'liveIntro': (data) => ({
        type: 'liveIntro',
        timestamp: Date.now(),
        data: {
            description: data.description,
            language: data.language,
            host: tiktokUserBaseData(data.host),
        }
    }),
    'roomUser': (data) => ({
        type: 'roomUser',
        timestamp: Date.now(),
        data: {
            viewerCount: data.viewerCount
        }
    }),
    'like': (data) => ({
        type: 'like',
        timestamp: Date.now(),
        data: {
            likeCount: data.likeCount,
            totalLikeCount: data.totalLikeCount,
            user: tiktokUserBaseData(data),
        }
    }),
    'chat': (data) => ({
        type: 'chat',
        timestamp: Date.now(),
        data: {
            comment: data.comment,
            contentLanguage: data.contentLanguage,
            user: tiktokUserBaseData(data),
        }
    }),
    'gift': (data) => ({
        type: 'gift',
        timestamp: Date.now(),
        data: {
            giftId: data.giftId,
            giftName: data.giftName,
            giftType: data.giftType,
            giftPictureUrl: data.giftPictureUrl,
            repeatCount: data.repeatCount,
            diamondCount: !isPendingStreak(data) && data.diamondCount > 0 ? data.diamondCount * data.repeatCount : 0,
            user: tiktokUserBaseData(data),
        }
    }),
    'member': (data) => ({
        type: 'member',
        timestamp: Date.now(),
        data: {
            memberCount: data.memberCount,
            user: tiktokUserBaseData(data),
        }
    }),
    'share': (data) => ({
        type: 'share',
        timestamp: Date.now(),
        data: {
            shareCount: data.shareCount,
            user: tiktokUserBaseData(data),
        }
    }),
    'streamEnd': (data) => ({
        type: 'streamEnd',
        timestamp: Date.now(),
        data: data
    }),
    'follow': (data) => ({
        type: 'follow',
        timestamp: Date.now(),
        data: {
            user: tiktokUserBaseData(data)
        }
    }),
    'subscribe': (data) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            user: tiktokUserBaseData(data)
        }
    }),
    'superFan': (data) => ({
        type: 'superFan',
        timestamp: Date.now(),
        data: {
            user: tiktokUserBaseData(data)
        }
    }),
};

// Twitch event transformers
const twitchEventTypeToTransformer: { [key: string]: (channel: string, tags: any, message?: string, self?: boolean) => StreamEvent } = {
    'chat': (channel, tags, message) => ({
        type: 'chat',
        timestamp: Date.now(),
        data: {
            comment: message || '',
            user: twitchUserBaseData(tags.username || '', tags),
            // badges: tags.badges,
            // emotes: tags.emotes, // Not sure how to use this
            color: tags.color,
            // mod: tags.mod,
            // subscriber: tags.subscriber,
            // turbo: tags.turbo,
            // 'message-type': tags['message-type'],
        }
    }),
    'cheer': (channel, tags, message) => ({
        type: 'gift',
        timestamp: Date.now(),
        data: {
            giftName: 'Bits',
            giftType: 'cheer',
            bits: tags.bits,
            comment: message || '',
            user: twitchUserBaseData(tags.username || '', tags),
        }
    }),
    'subscribe': (channel, tags, message) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            user: twitchUserBaseData(tags.username || '', tags),
            cumulativeMonths: tags['msg-param-cumulative-months'],
            streakMonths: tags['msg-param-streak-months'],
            // shouldShareStreak: tags['msg-param-should-share-streak'],
            message: message || '',
        }
    }),
    'subgift': (channel, tags, message) => ({
        type: 'gift',
        timestamp: Date.now(),
        data: {
            giftName: 'Subscription Gift',
            giftType: 'subgift',
            recipient: tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'],
            senderCount: tags['msg-param-sender-count'],
            user: twitchUserBaseData(tags.username || '', tags),
        }
    }),
    'submysterygift': (channel, tags, message) => ({
        type: 'gift',
        timestamp: Date.now(),
        data: {
            giftName: 'Mystery Subscription Gift',
            giftType: 'submysterygift',
            massGiftCount: tags['msg-param-mass-gift-count'],
            senderCount: tags['msg-param-sender-count'],
            user: twitchUserBaseData(tags.username || '', tags),
        }
    }),
    'raided': (channel, tags) => ({
        type: 'share',
        timestamp: Date.now(),
        data: {
            raider: tags['msg-param-displayName'] || tags['msg-param-login'],
            viewerCount: tags['msg-param-viewerCount'],
            user: twitchUserBaseData(tags.username || '', tags),
        }
    }),
    'messagedeleted': (channel, tags) => ({
        type: 'error',
        timestamp: Date.now(),
        data: {
            message: `Message deleted from ${tags.username}`,
            deletedMessage: tags['target-msg-id'],
        }
    }),
    'follow': (channel, tags) => ({
        type: 'follow',
        timestamp: Date.now(),
        data: {
            user: twitchUserBaseData(tags.username || '', tags),
        }
    }),
};

// Store events per platform-specific key (platform:streamerId)
const streamEvents: StreamEvents = {};

// Remember the last time a request was made of each requester
const requesterIdToLastRequestTimestamp: { [key: string]: number } = {};

// Enable cross origin resource sharing
const io = new Server(httpServer, {
    cors: {
        origin: '*'
    }
});

// Maps verwenden jetzt platform-spezifische Keys (platform:streamerId)
const streamerIdToSocketsMap: { [key: string]: any[] } = {};
const socketToPlatformKeyMap: { [key: string]: string } = {};

// TikTok connection maps - Keys sind platform:streamerId
const streamerIdToTikTokConnectionWrapperMap: { [key: string]: TikTokConnectionWrapper | undefined } = {};

// Twitch connection maps - Keys sind platform:streamerId
const streamerIdToTwitchClientMap: { [key: string]: tmi.Client | undefined } = {};

// Socket speichert auch die Plattform-Info
const socketToPlatformMap: { [key: string]: 'tiktok' | 'twitch' } = {};

const createInitialEventContainer = () => ({ events: [] });

const getConnetcionState = (tiktokConnectionWrapper: TikTokConnectionWrapper | undefined): string => {
    if (tiktokConnectionWrapper == undefined) {
        return '';
    }
    return (tiktokConnectionWrapper.connection as any)._connectState
}

const getOrCreateTiktokConnectionWrapper = (platformKey: string, streamerId: string, options: any) => {
    let tiktokConnectionWrapper = streamerIdToTikTokConnectionWrapperMap[platformKey];
    if (tiktokConnectionWrapper && getConnetcionState(tiktokConnectionWrapper) == 'DISCONNECTED') {
        streamerIdToTikTokConnectionWrapperMap[platformKey] = undefined;
        console.log('TiktokConnectionWrapper was disconnected. Try to create a new connection.');
        tiktokConnectionWrapper = undefined;
    }

    if (!tiktokConnectionWrapper) {
        try {
            tiktokConnectionWrapper = new TikTokConnectionWrapper(streamerId, options, true);
            tiktokConnectionWrapper.connect();
        } catch (err: any) {
            const errStr = err.toString();
            console.log('ERROR: ', errStr);
            return [undefined, errStr];
        }

        streamerIdToTikTokConnectionWrapperMap[platformKey] = tiktokConnectionWrapper;

        tiktokConnectionWrapper.once('connected', (state: any) => 
            streamerIdToSocketsMap[platformKey]?.forEach((socket) => 
                socket.emit('streamConnected', { platform: 'tiktok', state })
            )
        );
        
        tiktokConnectionWrapper.once('disconnected', (reason: any) => 
            streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                console.log('disconnected: ', reason);
                console.log('tiktokConnectionWrapper connectState: ', getConnetcionState(tiktokConnectionWrapper));
                return socket.emit('streamDisconnected', { platform: 'tiktok', reason });
            })
        );

        tiktokEventTypesToStore.forEach(eventType => {
            tiktokConnectionWrapper!.connection.on(eventType, (data: any) => {
                if (eventType == 'gift') {
                    if (isPendingStreak(data) || data.diamondCount < 1) {
                        return;
                    }
                }

                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }

                const dataTransformer = tiktokEventTypeToTransformer[eventType];
                if (dataTransformer) {
                    streamEvents[platformKey].events.push(dataTransformer(data));
                } else {
                    streamEvents[platformKey].events.push({
                        type: eventType,
                        data,
                        timestamp: Date.now()
                    });
                }

                streamerIdToSocketsMap[platformKey]?.forEach((socket) => 
                    socket.emit(eventType, { platform: 'tiktok', data })
                );
            });
        });

        tiktokConnectionWrapper!.connection.on('error', (data: any) => {
            console.log('tiktokConnectionWrapper connectState: ', getConnetcionState(tiktokConnectionWrapper));
            const currentStreamEvents = streamEvents[platformKey]
            if (!currentStreamEvents) {
                return;
            }
            const events = currentStreamEvents.events;
            if (!events) {
                return;
            }
            const errorMessage = 'Error: ' + data.info;
            // If we already have events, check if the previous wasn't the same error,
            // as errors tend to repeat through retries.
            if (events.length > 0) {
                const latestEvent = events[events.length - 1];
                if (latestEvent && latestEvent.type == 'error' && latestEvent.data == errorMessage) {
                    return;
                }
            }
            currentStreamEvents.events.push({
                type: 'error',
                data: errorMessage,
                timestamp: Date.now()
            });
        });
    }

    return [tiktokConnectionWrapper, undefined];
};

const getOrCreateTwitchConnectionWrapper = async (platformKey: string, streamerId: string, options: any) => {
    let twitchClient = streamerIdToTwitchClientMap[platformKey];
    const channel = '#' + streamerId.toLowerCase().replace('#', '');
    
    if (!twitchClient) {
        const clientConfig: tmi.Options = {
            options: { debug: false },
            connection: {
                reconnect: true,
                secure: true,
            },
            channels: [channel],
        };

        if (process.env.TWITCH_OAUTH_TOKEN) {
            clientConfig.identity = {
                username: process.env.TWITCH_USERNAME || 'justinfan12345',
                password: process.env.TWITCH_OAUTH_TOKEN,
            };
        }

        try {
            twitchClient = new tmi.client(clientConfig);

            // Handle connection
            twitchClient.on('connected', (address: string, port: number) => {
                console.log(`Twitch client connected to ${address}:${port} for ${streamerId}`);
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('streamConnected', { 
                        platform: 'twitch', 
                        state: { connected: true, address, port } 
                    });
                });
            });

            // Handle disconnection
            twitchClient.on('disconnected', (reason: string) => {
                console.log(`Twitch client disconnected for ${streamerId}: ${reason}`);
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('streamDisconnected', { platform: 'twitch', reason });
                });
            });

            // Chat messages
            twitchClient.on('chat', (targetChannel: string, tags: tmi.ChatUserstate, message: string, self: boolean) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['chat']!(targetChannel, tags, message, self);
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('chat', { platform: 'twitch', data: eventData.data });
                });
            });

            // Bits/Cheers
            twitchClient.on('cheer', (targetChannel: string, tags: tmi.ChatUserstate, message: string) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['cheer']!(targetChannel, tags, message);
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('gift', { platform: 'twitch', data: eventData.data });
                });
            });

            // New subscription
            twitchClient.on('subscription', (targetChannel: string, username: string, methods: tmi.SubMethods, message: string, tags: tmi.SubUserstate) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['subscribe']!(targetChannel, { ...tags, username }, message);
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('subscribe', { platform: 'twitch', data: eventData.data });
                });
            });

            // Resubscription
            twitchClient.on('resub', (targetChannel: string, username: string, months: number, message: string, tags: tmi.SubUserstate, methods: tmi.SubMethods) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['subscribe']!(targetChannel, { ...tags, username }, message);
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('subscribe', { platform: 'twitch', data: eventData.data });
                });
            });

            // Gift subscription
            twitchClient.on('subgift', (targetChannel: string, username: string, streakMonths: number, recipient: string, methods: tmi.SubMethods, tags: tmi.SubGiftUserstate) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['subgift']!(targetChannel, { ...tags, username });
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('gift', { platform: 'twitch', data: eventData.data });
                });
            });

            // Mystery gift subscription (mass gift)
            (twitchClient as any).on('submysterygift', (targetChannel: string, username: string, numOfSubs: number, methods: tmi.SubMethods, tags: tmi.SubGiftUserstate) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['submysterygift']!(targetChannel, { ...tags, username });
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('gift', { platform: 'twitch', data: eventData.data });
                });
            });

            // Raid
            (twitchClient as any).on('raided', (targetChannel: string, username: string, viewers: number, tags: tmi.RaidUserstate) => {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const eventData = twitchEventTypeToTransformer['raided']!(targetChannel, { ...tags, username });
                streamEvents[platformKey].events.push(eventData);
                        
                streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                    socket.emit('share', { platform: 'twitch', data: eventData.data });
                });
            });

            // Handle errors
            (twitchClient as any).on('error', (error: Error) => {
                console.error('Twitch client error:', error);
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }
                const errorMessage = 'Twitch Error: ' + error.message;
                streamEvents[platformKey].events.push({ type: 'error', data: errorMessage, timestamp: Date.now() });
            });

            // Connect to Twitch
            await twitchClient.connect();
            streamerIdToTwitchClientMap[platformKey] = twitchClient;
            
        } catch (err: any) {
            const errStr = err.toString();
            console.log('Twitch ERROR: ', errStr);
            return [undefined, errStr];
        }

    }
    return [twitchClient, undefined];
};

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
            socket.emit('streamDisconnected', { 
                platform: 'twitch', 
                reason: 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance.' 
            });
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

    socket.on('setUniqueId', setTikTokStreamerId);
    socket.on('setstreamerId', setTikTokStreamerId);
    socket.on('setTwitchStreamerId', setTwitchStreamerId);

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
                // Prüfe anhand des Keys, welche Plattform es war
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

    const platformType = (typeof platform === 'string' ? platform.toLowerCase() : 'tiktok') as 'tiktok' | 'twitch';
    const platformKey = getPlatformKey(platformType, streamerId);

    const options = { enableExtendedGiftInfo: true };

    if (platformType === 'twitch') {
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
        streamEvents[platformKey].events = streamEvents[platformKey].events.filter(event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE));
        
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
        streamEvents[platformKey].events = streamEvents[platformKey].events.filter(event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE));

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
