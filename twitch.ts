import tmi from 'tmi.js';
import type { StreamEvent, UserBaseData } from './events.model.js';
import {
    streamEvents,
    streamerIdToSocketsMap,
    streamerIdToTwitchClientMap,
    createInitialEventContainer
} from './types.js';

const twitchUserBaseData = (username: string, tags: tmi.ChatUserstate): UserBaseData => {
    return {
        userId: tags['user-id'] || username,
        uniqueId: tags['display-name'] || username,
    };
};

const subscriptionTagsToTier = (tags: tmi.ChatUserstate): string | undefined => {
    const sysMsg: string = tags['system-msg'];
    if (sysMsg.includes('subscribed with Prime')) {
        return 'Prime'; 
    }
    if (sysMsg.includes('subscribed at Tier')) {
        const tierPos = sysMsg.indexOf('Tier');
        return sysMsg.substring(tierPos, tierPos + 6)
    }
    return undefined
}

const twitchEventTypeToTransformer: { [key: string]: (channel: string, tags: any, message?: string, self?: boolean) => StreamEvent } = {
    'chat': (channel, tags, message) => ({
        type: 'chat',
        timestamp: Date.now(),
        data: {
            comment: message || '',
            // contentLanguage: '',
            user: twitchUserBaseData(tags.username || '', tags),
            // badges: tags.badges,
            // emotes: tags.emotes,
            // color: tags.color,
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
    'sub': (channel, tags, message) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            user: twitchUserBaseData(tags.username || '', tags),
            cumulativeMonths: tags['msg-param-cumulative-months'],
            streakMonths: tags['msg-param-streak-months'],
            tier: subscriptionTagsToTier(tags)
        },
    }),
    'resub': (channel, tags, message) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            user: twitchUserBaseData(tags.username || '', tags),
            cumulativeMonths: tags['msg-param-cumulative-months'],
            streakMonths: tags['msg-param-streak-months'],
            message: message || '',
            tier: subscriptionTagsToTier(tags)
        },
    }),
    'subgift': (channel, tags, message) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            giftName: 'Subscription Gift',
            giftType: 'subgift',
            recipient: tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'],
            senderCount: tags['msg-param-sender-count'],
            user: twitchUserBaseData(tags.username || '', tags),
            tier: subscriptionTagsToTier(tags)
        },
    }),
    'submysterygift': (channel, tags, message) => ({
        type: 'subscribe',
        timestamp: Date.now(),
        data: {
            giftName: 'Mystery Subscription Gift',
            giftType: 'submysterygift',
            massGiftCount: tags['msg-param-mass-gift-count'],
            senderCount: tags['msg-param-sender-count'],
            user: twitchUserBaseData(tags.username || '', tags),
            tier: subscriptionTagsToTier(tags)
        },
    }),
    'raided': (channel, tags) => ({
        type: 'raided',
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

export const getOrCreateTwitchConnectionWrapper = async (platformKey: string, streamerId: string, options: any) => {
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

        /*if (process.env.TWITCH_OAUTH_TOKEN) {
            clientConfig.identity = {
                username: process.env.TWITCH_USERNAME || 'justinfan12345',
                password: process.env.TWITCH_OAUTH_TOKEN,
            };
        }*/

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
                // console.log('sub tags: ', tags);
                const eventData = twitchEventTypeToTransformer['sub']!(targetChannel, { ...tags, username }, message);
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
                // console.log('resub tags: ', tags);
                const eventData = twitchEventTypeToTransformer['resub']!(targetChannel, { ...tags, username }, message);
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
                // console.log('subgift tags: ', tags);
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
                // console.log('submysterygift tags: ', tags);
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

export { twitchEventTypeToTransformer, twitchUserBaseData };
