import { TikTokConnectionWrapper } from './connectionWrapper.js';
import type { StreamEvent, UserBaseData } from './events.model.js';
import {
    DELETE_EVENTS_AGE,
    streamEvents,
    streamerIdToSocketsMap,
    getPlatformKey,
    createInitialEventContainer,
    type io as IoType
} from './types.js';

// io will be set from server.ts
let io: typeof IoType;

export function setTiktokIo(ioInstance: typeof IoType) {
    io = ioInstance;
}

// All known TikTok events
const tiktokEventTypesToStore = ['liveIntro', 'member', 'roomUser', 'chat', 'gift', 'like', 'follow', 'share', 'emote', 'envelope', 'subscribe', 'superFan', 'streamEnd'];

function isPendingStreak(data: any): boolean {
    return data.giftType === 1 && !data.repeatEnd;
}

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
        data: { viewerCount: data.viewerCount }
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
        data: { memberCount: data.memberCount, user: tiktokUserBaseData(data), }
    }),
    'share': (data) => ({
        type: 'share',
        timestamp: Date.now(),
        data: { shareCount: data.shareCount, user: tiktokUserBaseData(data), }
    }),
    'streamEnd': (data) => ({ type: 'streamEnd', timestamp: Date.now(), data: data }),
    'follow': (data) => ({ type: 'follow', timestamp: Date.now(), data: { user: tiktokUserBaseData(data) } }),
    'subscribe': (data) => ({ type: 'subscribe', timestamp: Date.now(), data: { user: tiktokUserBaseData(data) } }),
    'superFan': (data) => ({ type: 'superFan', timestamp: Date.now(), data: { user: tiktokUserBaseData(data) } }),
};

const getConnetcionState = (tiktokConnectionWrapper: TikTokConnectionWrapper | undefined): string => {
    if (tiktokConnectionWrapper == undefined) {
        return '';
    }
    return (tiktokConnectionWrapper.connection as any)._connectState
};

// TikTok connection maps - Keys are platform:streamerId
import { streamerIdToTikTokConnectionWrapperMap } from './types.js';

export const getOrCreateTiktokConnectionWrapper = (platformKey: string, streamerId: string, options: any) => {
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
                    streamEvents[platformKey].events.push({ type: eventType, data, timestamp: Date.now() });
                }

                streamerIdToSocketsMap[platformKey]?.forEach((socket) =>
                    socket.emit(eventType, { platform: 'tiktok', data })
                );
            });
        });

        tiktokConnectionWrapper!.connection.on('error', (data: any) => {
            console.log('tiktokConnectionWrapper connectState: ', getConnetcionState(tiktokConnectionWrapper));
            const currentStreamEvents = streamEvents[platformKey];
            if (!currentStreamEvents) {
                return;
            }
            const events = currentStreamEvents.events;
            if (!events) {
                return;
            }
            const errorMessage = 'Error: ' + data.info;

            // If we already have events, check if the previous wasn't the same error
            if (events.length > 0) {
                const latestEvent = events[events.length - 1];
                if (latestEvent && latestEvent.type == 'error' && latestEvent.data == errorMessage) {
                    return;
                }
            }
            currentStreamEvents.events.push({ type: 'error', data: errorMessage, timestamp: Date.now() });
        });
    }

    return [tiktokConnectionWrapper, undefined];
};

export { tiktokEventTypeToTransformer, tiktokUserBaseData, isPendingStreak, getPlatformKey, DELETE_EVENTS_AGE };
