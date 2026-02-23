import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokConnectionWrapper, getGlobalConnectionCount } from './connectionWrapper';
import { clientBlocked } from './limiter';

const app = express();
const httpServer = createServer(app);

// Keep events for 30 minutes
const DELETE_EVENTS_AGE = 30 * 60 * 1000;

// All known events: ['roomUser', 'member', 'chat', 'gift', 'social', 'like', 'questionNew', 'linkMicBattle', 'linkMicArmies', 'liveIntro', 'emote', 'envelope', 'subscribe', 'streamEnd', 'superFan'];
const eventTypesToStore = ['liveIntro', 'member', 'roomUser', 'chat', 'gift', 'like', 'follow', 'share', 'emote', 'envelope', 'subscribe', 'superFan', 'streamEnd'];


const userBaseData = (data: any): UserBaseData => {
    let profilePictureUrl: string | string[] = data.profilePictureUrl ? data.profilePictureUrl : data.profilePicture.url;
    if (Array.isArray(profilePictureUrl)) {
        profilePictureUrl = profilePictureUrl.length > 0 ? profilePictureUrl[0] : '';
    }
    return {
        userId: data.userId,
        uniqueId: data.uniqueId,
        nickname: data.nickname,
        profilePictureUrl: data.profilePictureUrl,
    };
};

function isPendingStreak(data: any): boolean {
    return data.giftType === 1 && !data.repeatEnd;
}

const eventTypeToTransformer: { [key: string]: (data: any) => StreamEvent } = {
    'liveIntro': (data) => ({ type: 'liveIntro', timestamp: Date.now(), data: {
        description: data.description,
        language: data.language,
        host: userBaseData(data.host),
    }}),
    'roomUser': (data) => ({ type: 'roomUser', timestamp: Date.now(), data: {
        viewerCount: data.viewerCount
    }}),
    'like': (data) => ({
        type: 'like', timestamp: Date.now(), data: {
            likeCount: data.likeCount,
            totalLikeCount: data.totalLikeCount,
            user: userBaseData(data),
        }
    }),
    'chat': (data) => ({
        type: 'chat', timestamp: Date.now(), data: {
            comment: data.comment,
            contentLanguage: data.contentLanguage,
            user: userBaseData(data),
        }
    }),
    'gift': (data) => ({
        type: 'gift', timestamp: Date.now(), data: {
            giftId: data.giftId,
            giftName: data.giftName,
            giftType: data.giftType,
            giftPictureUrl: data.giftPictureUrl,
            repeatCount: data.repeatCount,
            diamondCount: !isPendingStreak(data) && data.diamondCount > 0 ? data.diamondCount * data.repeatCount : 0,
            user: userBaseData(data),
        }
    }),
    'member': (data) => ({
        type: 'member', timestamp: Date.now(), data: {
            memberCount: data.memberCount,
            user: userBaseData(data),
        }
    }),
    'share': (data) => ({
        type: 'share', timestamp: Date.now(), data: {
            shareCount: data.shareCount,
            user: userBaseData(data),
        }
    }),
    'streamEnd': (data) => ({ type: 'streamEnd', timestamp: Date.now(), data: data}),
    'follow': (data) => ({ type: 'follow', timestamp: Date.now(), data: { user: userBaseData(data) } }),
    'subscribe': (data) => ({ type: 'subscribe', timestamp: Date.now(), data: { user: userBaseData(data) } }),
    'superFan': (data) => ({ type: 'superFan', timestamp: Date.now(), data: { user: userBaseData(data) } }),
};

// Store events per unique ID
const streamEvents: { [key: string]: { events: StreamEvent[] } } = {};

// Remember the last time a request was made of each requester
const requesterIdToLastRequestTimestamp: { [key: string]: number } = {};

// Enable cross origin resource sharing
const io = new Server(httpServer, {
    cors: {
        origin: '*'
    }
});

const streamerIdToSocketsMap: { [key: string]: any[] } = {};
const socketTostreamerIdMap: { [key: string]: string } = {};
const streamerIdToTikTokConnectionWrapperMap: { [key: string]: TikTokConnectionWrapper | undefined } = {};

const createInitialEventContainer = () => ({ events: [] });

const getConnetcionState = (tiktokConnectionWrapper: TikTokConnectionWrapper | undefined): string => {
    if (tiktokConnectionWrapper == undefined) {
        return '';
    }
    // Encapsulate with protection ignoring getter
    return (tiktokConnectionWrapper.connection as any)._connectState
}

const getOrCreateTiktokConnectionWrapper = (streamerId: string, options: any) => {
    let tiktokConnectionWrapper = streamerIdToTikTokConnectionWrapperMap[streamerId];

    if (tiktokConnectionWrapper && getConnetcionState(tiktokConnectionWrapper) == 'DISCONNECTED') {
        streamerIdToTikTokConnectionWrapperMap[streamerId] = undefined;
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

        streamerIdToTikTokConnectionWrapperMap[streamerId] = tiktokConnectionWrapper;

        tiktokConnectionWrapper.once('connected', state => streamerIdToSocketsMap[streamerId]?.forEach((socket) => socket.emit('tiktokConnected', state)));
        tiktokConnectionWrapper.once('disconnected', reason => streamerIdToSocketsMap[streamerId]?.forEach((socket) => {
            console.log('disconnected: ', reason);
            console.log('tiktokConnectionWrapper connectState: ', getConnetcionState(tiktokConnectionWrapper));
            return socket.emit('tiktokDisconnected', reason);
        }));

        eventTypesToStore.forEach(eventType => {
            tiktokConnectionWrapper!.connection.on(eventType, (data: any) => {
                if (eventType == 'gift') {
                    if (isPendingStreak(data) || data.diamondCount < 1) {
                        // Skipped Gift Event. We are already interested in the end of a streak.
                        return;
                    }
                }

                if (!streamEvents[streamerId]) {
                    streamEvents[streamerId] = createInitialEventContainer();
                }
                const dataTransformer = eventTypeToTransformer[eventType];
                if (dataTransformer) {
                    streamEvents[streamerId].events.push(dataTransformer(data));
                } else {
                    streamEvents[streamerId].events.push({ type: eventType, data, timestamp: Date.now() });
                }

                streamerIdToSocketsMap[streamerId]?.forEach((socket) => socket.emit(eventType, data));
            });
        });
        tiktokConnectionWrapper!.connection.on('error', (data: any) => {
            console.log('tiktokConnectionWrapper connectState: ', getConnetcionState(tiktokConnectionWrapper));
            const events = streamEvents[streamerId]?.events;
            if (!events) {
                return;
            }
            const errorMessage = 'Error: ' + data.info;
            if (events.length > 0) {
                const latestEvent = events[events.length - 1];
                if (latestEvent.type == 'error' && latestEvent.data == errorMessage) {
                    return;
                }
            }
            streamEvents[streamerId].events.push({ type: 'error', data: errorMessage, timestamp: Date.now() });
        });
    }
    return [tiktokConnectionWrapper, undefined];
};

io.on('connection', (socket) => {
    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    const setStreamerId = (streamerId: string, options: any) => {
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
            socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.');
            return;
        }

        let socketList: any[];
        if (streamerIdToSocketsMap[streamerId]) {
            socketList = streamerIdToSocketsMap[streamerId];
        } else {
            socketList = [];
            streamerIdToSocketsMap[streamerId] = socketList;
        }

        const [tiktokConnectionWrapper, errStr] = getOrCreateTiktokConnectionWrapper(streamerId, options);

        if (tiktokConnectionWrapper) {
            socketList.push(socket);
            socketTostreamerIdMap[socket.id] = streamerId; // Use socket.id as key
        } else {
            socket.emit('tiktokDisconnected', errStr);
            return;
        }
    };

    socket.on('setUniqueId', setStreamerId);
    socket.on('setstreamerId', setStreamerId);

    socket.on('disconnect', () => {
        const streamerId = socketTostreamerIdMap[socket.id]; // Use socket.id as key
        if (streamerId) {
            const socketList = streamerIdToSocketsMap[streamerId];
            const socketIndex = socketList.indexOf(socket);
            if (socketIndex > -1) {
                socketList.splice(socketIndex, 1);
            }
            delete socketTostreamerIdMap[socket.id]; // Delete the entry
        }
    });
});

app.get('/events', (req, res) => {
    const { streamerId, requesterId } = req.query;
    if (typeof streamerId !== 'string') {
        return res.status(400).send('Missing streamerId parameter.');
    }
    if (typeof requesterId !== 'string') {
        return res.status(400).send('Missing requesterId parameter.');
    }

    const options = {
        enableExtendedGiftInfo: true
    };
    const [tiktokConnectionWrapper, errStr] = getOrCreateTiktokConnectionWrapper(streamerId, options);

    if (errStr) {
        return res.json({ events: [], message: errStr });
    }

    if (!streamEvents[streamerId]) {
        streamEvents[streamerId] = createInitialEventContainer();
    }

    if (!requesterIdToLastRequestTimestamp[requesterId]) {
        requesterIdToLastRequestTimestamp[requesterId] = Date.now();
        return res.json({ events: [], message: 'New ID registered. No events yet.' });
    }

    const { events } = streamEvents[streamerId];
    const newEvents = events.filter(event => event.timestamp > requesterIdToLastRequestTimestamp[requesterId]);

    requesterIdToLastRequestTimestamp[requesterId] = Date.now();
    streamEvents[streamerId].events = streamEvents[streamerId].events.filter(event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE));

    res.json({
        events: newEvents.map(event => ({ type: event.type, data: event.data }))
    });
});

setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000);

app.use(express.static('public'));

const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);
