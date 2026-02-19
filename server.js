
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { TikTokConnectionWrapper, getGlobalConnectionCount } = require('./connectionWrapper');
const { clientBlocked } = require('./limiter');

const app = express();
const httpServer = createServer(app);

// Keep events for 30 minutes
const DELETE_EVENTS_AGE = 30 * 60 * 1000;

// All known events: ['roomUser', 'member', 'chat', 'gift', 'social', 'like', 'questionNew', 'linkMicBattle', 'linkMicArmies', 'liveIntro', 'emote', 'envelope', 'subscribe', 'streamEnd', 'superFan'];
const eventTypesToStore = ['liveIntro', 'member', 'roomUser', 'chat', 'gift', 'like', 'follow', 'share', 'emote', 'envelope', 'subscribe', 'superFan', 'streamEnd'];
// const eventTypesToStore = ['questionNew', 'linkMicBattle', 'linkMicArmies', 'emote', 'envelope', 'subscribe', 'streamEnd', 'superFan'];

const userBaseData = (data) => ({
    userId: data.userId,
    uniqueId: data.uniqueId,
    nickname: data.nickname,
    profilePictureUrl: data.profilePictureUrl,
});

function isPendingStreak(data) {
    return data.giftType === 1 && !data.repeatEnd;
}
const eventTypeToTransformer = Object.assign({
    'roomUser': (data) => ({ type: 'roomUser', timestamp: Date.now(), data: {
        viewerCount: data.viewerCount
    }}),
    'like': (data) => ({ type: 'like', timestamp: Date.now(), data: {
        likeCount: data.likeCount,
        totalLikeCount: data.totalLikeCount,
        user: userBaseData(data),
    }}),
    'chat': (data) => ({ type: 'chat', timestamp: Date.now(), data: {
        comment: data.comment,
        contentLanguage: data.contentLanguage,
        user: userBaseData(data),
    }}),
    'gift': (data) => ({ type: 'gift', timestamp: Date.now(), data: {
        giftId: data.giftId,
        giftName: data.giftName,
        giftType: data.giftType,
        giftPictureUrl: data.giftPictureUrl,
        diamondCount: !isPendingStreak(data) && data.diamondCount > 0 ? data.diamondCount * data.repeatCount : 0,
        user: userBaseData(data),
    }}),
    'member': (data) => ({ type: 'member', timestamp: Date.now(), data: {
        memberCount: data.memberCount, // total viewers
        user: userBaseData(data),
    }}),
    'share': (data) => ({ type: 'share', timestamp: Date.now(), data: {
        shareCount: data.shareCount, // Total shares of current stream
        user: userBaseData(data),
    }}),
    /*'social': (data) => ({ type: 'social', timestamp: Date.now(), data: {
        displayType: data.displayType, // can be follow or share => data.displayType.includes('follow')
        // TODO? label: data.label.replace('{0:user}', ''),
        data: data,
        // shareType: data.shareType, // eg. "0"
        // action: data.action, // eg. "1"
        // shareTarget: data.shareTarget, // eg. "7094309508386079750"
        user: userBaseData(data),
    }}),*/
    /*'follow': (data) => ({ type: 'follow', timestamp: Date.now(), data: {
        user: userBaseData(data),
    }}),
    'subscribe': (data) => ({ type: 'subscribe', timestamp: Date.now(), data: {
        user: userBaseData(data),
    }}),
    'superFan': (data) => ({ type: 'superFan', timestamp: Date.now(), data: {
        user: userBaseData(data),
    }}),*/
    // TODO emote Triggered every time a subscriber sends an emote (sticker).
    'streamEnd': (data) => ({ type: 'streamEnd', timestamp: Date.now(), data: data}),
}, ...['follow', 'subscribe', 'superFan'].map((type) => ({[type]: (data) => ({ type, timestamp: Date.now(), data: { user: userBaseData(data), }})
    }))
);

// Store events per unique ID
const streamEvents = {};

// Remember the last time a request was made of each requester
const requesterIdToLastRequestTimestamp = {};

// Enable cross origin resource sharing
const io = new Server(httpServer, {
    cors: {
        origin: '*'
    }
});

const streamerIdToSocketsMap = {};
const socketTostreamerIdMap = {};
const streamerIdToTikTokConnectionWrapperMap = {};

const createInitialEventContainer = () => ({ events: [] });

const getOrCreateTiktokConnectionWrapper = (streamerId, options) => {
    let tiktokConnectionWrapper;
    // Load tiktokConnectionWrapper if already exists
    if (streamerIdToTikTokConnectionWrapperMap[streamerId]) {
        tiktokConnectionWrapper = streamerIdToTikTokConnectionWrapperMap[streamerId];
    } else {
        // Else create a new one and connect to the given username (streamerId)
        try {
            tiktokConnectionWrapper = new TikTokConnectionWrapper(streamerId, options, true);
            tiktokConnectionWrapper.connect();
        } catch (err) {
            const errStr = err.toString();
            console.log('ERROR: ', errStr);
            return [undefined, errStr];
        }

        streamerIdToTikTokConnectionWrapperMap[streamerId] = tiktokConnectionWrapper;

        // Redirect wrapper control events once
        tiktokConnectionWrapper.once('connected', state => streamerIdToSocketsMap[streamerId]?.forEach((socket) => socket.emit('tiktokConnected', state)));
        tiktokConnectionWrapper.once('disconnected', reason => streamerIdToSocketsMap[streamerId]?.forEach((socket) => socket.emit('tiktokDisconnected', reason)));

        // Store and redirect message events
        eventTypesToStore.forEach(eventType => {
            tiktokConnectionWrapper.connection.on(eventType, data => {
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
    }
    return [tiktokConnectionWrapper, undefined];
}

io.on('connection', (socket) => {
    // let tiktokConnectionWrapper;

    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    const setStreamerId = (streamerId, options) => {

        // Prohibit the client from specifying these options (for security reasons)
        if (typeof options === 'object' && options) {
            delete options.requestOptions;
            delete options.websocketOptions;
        } else {
            options = {};
        }

        // Session ID in .env file is optional
        if (process.env.SESSIONID) {
            options.sessionId = process.env.SESSIONID;
            console.info('Using SessionId');
        }

        // Check if rate limit exceeded
        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.');
            return;
        }

        let socketList;
        if (streamerIdToSocketsMap[streamerId]) {
            socketList = streamerIdToSocketsMap[streamerId];
        } else {
            socketList = [];
            streamerIdToSocketsMap[streamerId] = socketList;
        }

        // Load tiktokConnectionWrapper if already exists, else create a new one
        const [tiktokConnectionWrapper, errStr] = getOrCreateTiktokConnectionWrapper(streamerId, options);

        if (tiktokConnectionWrapper) {
            socketList.push(socket);
            socketTostreamerIdMap[socket] = streamerId;
        } else {
            socket.emit('tiktokDisconnected', errStr);
            // ? socket.disconnect();
            return;
        }
    };

    socket.on('setUniqueId', setStreamerId); // Used by website
    socket.on('setstreamerId', setStreamerId); // Used by the rest

    socket.on('disconnect', () => {
        /*if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
        }*/
        const streamerId = socketTostreamerIdMap[socket];
        if (streamerId) {
            const socketList = streamerIdToSocketsMap[streamerId];
            const socketIndex = socketList.indexOf(socket);
            if (socketIndex > -1) {
                socketList.splice(socketIndex, 1); // 2nd parameter means remove one item only
            }
            socketTostreamerIdMap[socket] = undefined;
        }
    });
});

// New endpoint to get updates since last request
app.get('/events', (req, res) => {
    const { streamerId, requesterId } = req.query;
    if (!streamerId) {
        return res.status(400).send('Missing streamerId parameter.');
    }
    if (!requesterId) {
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

    requesterIdToLastRequestTimestamp[requesterId] = Date.now(); // Update last request time
    // Delete old events
    streamEvents[streamerId].events = streamEvents[streamerId].events.filter(event => event.timestamp > (Date.now() - DELETE_EVENTS_AGE));

    res.json({
        events: newEvents.map(event => ({ type: event.type, data: event.data }))
    });
});

// Emit global connection statistics
setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000)

// Serve frontend files
app.use(express.static('public'));

// Start http listener
const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);
