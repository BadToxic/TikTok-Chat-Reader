import type { StreamEvent, UserBaseData } from './events.model.js';
import {
    streamEvents,
    streamerIdToSocketsMap,
    streamerIdToYouTubeConnectionMap,
    streamerIdToYouTubeLastRequestMap,
    createInitialEventContainer,
} from './types.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const INACTIVITY_TIMEOUT_MS = 30 * 1000; // 30 seconds

// Store polling state per platform key
const pollInProgressMap: { [key: string]: boolean } = {};

const youtubeUserBaseData = (authorDetails: any): UserBaseData => {
    return {
        userId: authorDetails.channelId,
        uniqueId: authorDetails.displayName,
        nickname: authorDetails.displayName,
        profilePictureUrl: authorDetails.profileImageUrl,
    };
};

const youtubeEventTypeToTransformer: { [key: string]: (data: any, authorDetails: any) => StreamEvent } = {
    'chat': (data, authorDetails) => ({
        type: 'chat',
        timestamp: Date.now(),
        data: {
            comment: data.textMessageDetails?.messageText || data.snippet?.displayMessage || '',
            contentLanguage: '',
            user: youtubeUserBaseData(authorDetails),
        }
    }),
    'gift': (data, authorDetails) => ({
        type: 'gift',
        timestamp: Date.now(),
        data: {
            giftId: data.id,
            giftName: 'Super Chat',
            giftType: 'superchat',
            giftPictureUrl: '',
            repeatCount: 1,
            diamondCount: data.snippet?.superChatDetails?.amountMicros
                ? data.snippet.superChatDetails.amountMicros / 1000000
                : 0,
            user: youtubeUserBaseData(authorDetails),
        }
    }),
    'member': (data, authorDetails) => ({
        type: 'member',
        timestamp: Date.now(),
        data: {
            memberCount: 1,
            user: youtubeUserBaseData(authorDetails),
        }
    }),
};

// Get live video ID for a channel
async function getLiveVideoId(apiKey: string, channelId: string): Promise<string | null> {
    try {
        const response = await fetch(
            `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${apiKey}`
        );

        if (!response.ok) {
            throw new Error(`YouTube API error: ${response.status}`);
        }

        const data = await response.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].id.videoId;
        }
        return null;
    } catch (err) {
        console.error('Error fetching live video:', err);
        return null;
    }
}

// Get active live chat ID for a video
async function getLiveChatId(apiKey: string, videoId: string): Promise<string | null> {
    try {
        const response = await fetch(
            `${YOUTUBE_API_BASE}/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`
        );

        if (!response.ok) {
            throw new Error(`YouTube API error: ${response.status}`);
        }

        const data = await response.json();
        if (data.items && data.items.length > 0 && data.items[0].liveStreamingDetails) {
            return data.items[0].liveStreamingDetails.activeLiveChatId;
        }
        return null;
    } catch (err) {
        console.error('Error fetching live chat ID:', err);
        return null;
    }
}

// Poll YouTube live chat messages
async function pollYouTubeChat(
    apiKey: string,
    liveChatId: string,
    platformKey: string,
    nextPageToken?: string
): Promise<string | undefined> {
    try {
        const url = `${YOUTUBE_API_BASE}/liveChat/messages?part=snippet,authorDetails&liveChatId=${liveChatId}&key=${apiKey}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`YouTube API error: ${response.status}`);
        }

        const data = await response.json();
        const items = data.items || [];

        items.forEach((item: any) => {
            if (!streamEvents[platformKey]) {
                streamEvents[platformKey] = createInitialEventContainer();
            }

            const authorDetails = item.authorDetails;
            const snippet = item.snippet;

            // Determine event type based on message type
            let eventType = 'chat';
            if (snippet.superChatDetails) {
                eventType = 'gift';
            } else if (snippet.type === 'newSponsor') {
                eventType = 'member';
            }

            const eventData = youtubeEventTypeToTransformer[eventType]!(item, authorDetails);
            streamEvents[platformKey].events.push(eventData);

            streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                socket.emit(eventType, { platform: 'youtube', data: eventData.data });
            });
        });

        return data.nextPageToken;
    } catch (err: any) {
        console.error('Error polling YouTube chat:', err);
        throw err;
    }
}

// Check if we should continue polling (has active requests and not timed out)
function shouldPollYouTube(platformKey: string): boolean {
    const connection = streamerIdToYouTubeConnectionMap[platformKey];
    if (!connection?.isConnected) {
        return false;
    }

    const lastRequest = streamerIdToYouTubeLastRequestMap[platformKey] || 0;
    const now = Date.now();

    // Check if last request was within 30 seconds
    if (now - lastRequest > INACTIVITY_TIMEOUT_MS) {
        console.log(`YouTube connection ${platformKey} inactive for ${INACTIVITY_TIMEOUT_MS * 1000} seconds, disconnecting...`);
        disconnectYouTube(platformKey);
        return false;
    }

    return true;
}

// Update last request timestamp for a platform key
export function updateYouTubeLastRequest(platformKey: string) {
    streamerIdToYouTubeLastRequestMap[platformKey] = Date.now();
}

export const getOrCreateYouTubeConnectionWrapper = async (
    platformKey: string,
    streamerId: string,
    options: { apiKey?: string }
): Promise<[any | undefined, string | undefined]> => {
    let connection = streamerIdToYouTubeConnectionMap[platformKey];

    if (connection?.isConnected) {
        // Update last request timestamp on existing connection
        updateYouTubeLastRequest(platformKey);
        return [connection, undefined];
    }

    const apiKey = options.apiKey || process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        return [undefined, 'YouTube API key is required. Please provide it via options.apiKey or YOUTUBE_API_KEY environment variable.'];
    }

    try {
        // Get channel ID from streamerId (could be channel ID or handle)
        const channelId = streamerId;

        // Get live video ID
        const videoId = await getLiveVideoId(apiKey, channelId);
        if (!videoId) {
            return [undefined, 'No live stream found for this channel.'];
        }

        // Get live chat ID
        const liveChatId = await getLiveChatId(apiKey, videoId);
        if (!liveChatId) {
            return [undefined, 'No active live chat found for this stream.'];
        }

        // Create connection
        connection = {
            apiKey,
            isConnected: true,
            lastRequestTimestamp: Date.now(),
            videoId,
            liveChatId,
        };
        streamerIdToYouTubeConnectionMap[platformKey] = connection;
        updateYouTubeLastRequest(platformKey);

        // Start polling
        let nextPageToken: string | undefined;

        const poll = async () => {
            // Check if we should poll (has active requests and not timed out)
            if (!shouldPollYouTube(platformKey)) {
                return;
            }

            // Prevent parallel polling
            if (pollInProgressMap[platformKey]) {
                setTimeout(poll, POLL_INTERVAL_MS);
                return;
            }

            pollInProgressMap[platformKey] = true;

            try {
                const currentConnection = streamerIdToYouTubeConnectionMap[platformKey];
                if (currentConnection?.isConnected) {
                    nextPageToken = await pollYouTubeChat(apiKey, liveChatId, platformKey, nextPageToken);
                }
            } catch (err) {
                console.error('Poll error:', err);
            } finally {
                pollInProgressMap[platformKey] = false;
            }

            // Schedule next poll only if still connected
            const currentConnection = streamerIdToYouTubeConnectionMap[platformKey];
            if (currentConnection?.isConnected) {
                setTimeout(poll, POLL_INTERVAL_MS);
            }
        };

        // Start first poll
        poll();

        // Notify connected
        streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
            socket.emit('streamConnected', { platform: 'youtube', state: { connected: true, videoId, liveChatId } });
        });

        return [connection, undefined];
    } catch (err: any) {
        const errStr = err.toString();
        console.log('YouTube ERROR: ', errStr);
        return [undefined, errStr];
    }
};

export const disconnectYouTube = (platformKey: string) => {
    const connection = streamerIdToYouTubeConnectionMap[platformKey];
    if (connection) {
        connection.isConnected = false;
        if (connection.intervalId) {
            clearInterval(connection.intervalId);
        }
        streamerIdToYouTubeConnectionMap[platformKey] = undefined;
        delete pollInProgressMap[platformKey];
        delete streamerIdToYouTubeLastRequestMap[platformKey];

        // Notify disconnected
        streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
            socket.emit('streamDisconnected', { platform: 'youtube', reason: 'Client disconnected' });
        });
    }
};

export { youtubeEventTypeToTransformer, youtubeUserBaseData };
