import type { StreamEvent, UserBaseData } from './events.model.js';
import {
    streamEvents,
    streamerIdToSocketsMap,
    streamerIdToTwitchOfficialConnectionMap,
    createInitialEventContainer,
} from './types.js';

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
const TWITCH_AUTH_BASE = 'https://id.twitch.tv/oauth2';

const POLL_INTERVAL_MS = 10000; // Poll followers every 10 seconds
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface TwitchTokenData {
    access_token: string;
    expires_at: number;
}

interface TwitchUser {
    id: string;
    login: string;
    display_name: string;
    profile_image_url: string;
}

// Store state per platform key
const pollInProgressMap: { [key: string]: boolean } = {};
const streamerIdToTwitchLastRequestMap: { [key: string]: number } = {};
const twitchTokenCache: { [key: string]: TwitchTokenData } = {};
const lastFollowerCache: { [key: string]: string } = {};

const twitchOfficialUserBaseData = (user: any): UserBaseData => {
    return {
        userId: user.user_id || user.id,
        uniqueId: user.user_login || user.login,
        nickname: user.user_name || user.display_name,
        // profilePictureUrl: user.profile_image_url || '',
    };
};

// Get OAuth token for Twitch API (Client Credentials)
async function getTwitchOAuthToken(clientId: string, clientSecret: string): Promise<string | null> {
    const cacheKey = `${clientId}`;
    const cachedToken = twitchTokenCache[cacheKey];

    if (cachedToken && Date.now() < cachedToken.expires_at - 5 * 60 * 1000) {
        return cachedToken.access_token;
    }

    try {
        const response = await fetch(
            `${TWITCH_AUTH_BASE}/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
            { method: 'POST' }
        );

        if (!response.ok) {
            throw new Error(`Twitch OAuth error: ${response.status}`);
        }

        const data = await response.json();
        const expires_at = Date.now() + (data.expires_in * 1000);

        twitchTokenCache[cacheKey] = {
            access_token: data.access_token,
            expires_at,
        };

        return data.access_token;
    } catch (err) {
        console.error('Error getting Twitch OAuth token:', err);
        return null;
    }
}

// Get user info by login
async function getTwitchUser(token: string, clientId: string, login: string): Promise<TwitchUser | null> {
    try {
        const response = await fetch(
            `${TWITCH_API_BASE}/users?login=${login}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Client-Id': clientId,
                }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Twitch API error ${response.status} for user ${login}: ${errorText}`);
            
            // Parse error for better logging
            try {
                const errorJson = JSON.parse(errorText);
                if (response.status === 401 && errorJson.message?.includes('Invalid OAuth token')) {
                    console.error(`
⚠️  TOKEN MISMATCH DETECTED ⚠️
The provided TWITCH_ACCESS_TOKEN was not generated for your TWITCH_CLIENT_ID.

To get the correct token:
1. Go to https://dev.twitch.tv/console
2. Create an app with your Client ID: ${clientId.substring(0, 10)}...
3. Generate an OAuth token with scope 'user:read:follows'
4. Make sure the token belongs to THIS specific Client ID

Tokens from twitchtokengenerator.com won't work with your Client ID.
                    `);
                }
            } catch (e) {
                // Not JSON, ignore
            }
            
            throw new Error(`Twitch API error: ${response.status}`);
        }

        const data = await response.json();
        if (data.data && data.data.length > 0) {
            return data.data[0];
        }
        return null;
    } catch (err) {
        console.error('Error fetching Twitch user:', err);
        return null;
    }
}

// Poll Twitch followers
async function pollTwitchFollowers(
    token: string,
    clientId: string,
    broadcasterId: string,
    platformKey: string
): Promise<void> {
    try {
        const url = `${TWITCH_API_BASE}/channels/followers?broadcaster_id=${broadcasterId}&first=100`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Client-Id': clientId,
            }
        });

        if (!response.ok) {
            throw new Error(`Twitch API error: ${response.status}`);
        }

        const data = await response.json();
        const followers = data.data || [];

        // Process followers
        const cache = lastFollowerCache[platformKey];
        if (cache != undefined) {
            const newFollowers = [];
            for (const follower of [...followers]) {
                const followerId = follower.user_id;
                if (lastFollowerCache[platformKey] === followerId) {
                    break;
                }
                newFollowers.push(follower);
            }

            if (newFollowers.length > 0) {
                if (!streamEvents[platformKey]) {
                    streamEvents[platformKey] = createInitialEventContainer();
                }

                for (const follower of [...newFollowers]) {
                    const eventData: StreamEvent = {
                        type: 'follow',
                        timestamp: new Date(follower.followed_at).getTime() || Date.now(),
                        data: {
                            user: twitchOfficialUserBaseData(follower),
                        }
                    };

                    streamEvents[platformKey].events.push(eventData);
                    streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
                        socket.emit('follow', { platform: 'twitch', data: eventData.data });
                    });

                    lastFollowerCache[platformKey] = follower.user_id;
                }
            }
        } else if (followers.length > 0) {
            lastFollowerCache[platformKey] = followers[0].user_id;
        }

    } catch (err) {
        console.error('Error polling Twitch followers:', err);
    }
}

// Check if we should continue polling
function shouldPollTwitch(platformKey: string): boolean {
    const connection = streamerIdToTwitchOfficialConnectionMap[platformKey];
    if (!connection) {
        return false;
    }

    const lastRequest = streamerIdToTwitchLastRequestMap[platformKey] || 0;
    if (Date.now() - lastRequest > INACTIVITY_TIMEOUT_MS) {
        console.log(`Twitch official connection ${platformKey} inactive for 5 minutes, disconnecting...`);
        disconnectTwitchOfficial(platformKey);
        return false;
    }

    return true;
}

// Update last request timestamp
export function updateTwitchLastRequest(platformKey: string) {
    streamerIdToTwitchLastRequestMap[platformKey] = Date.now();
}

/**
 * Creates a connection to Twitch Official API for followers.
 * Uses TWITCH_ACCESS_TOKEN if available, otherwise falls back to Client Credentials.
 * For Chat/Subs/Gifts/Raids, use tmi.js (twitch.ts) instead.
 */
export const getOrCreateTwitchOfficialConnectionWrapper = async (
    platformKey: string,
    streamerId: string,
    options: { clientId?: string; clientSecret?: string; accessToken?: string }
): Promise<[any | undefined, string | undefined]> => {
    const clientId = options.clientId || process.env.TWITCH_CLIENT_ID;
    const clientSecret = options.clientSecret || process.env.TWITCH_CLIENT_SECRET;
    const accessToken = options.accessToken || process.env.TWITCH_ACCESS_TOKEN;

    // At least Client ID and Secret are required for user lookup
    if (!clientId || !clientSecret) {
        return [undefined, 'Twitch Client ID and Client Secret are required. Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables.'];
    }

    let connection = streamerIdToTwitchOfficialConnectionMap[platformKey];

    if (connection) {
        updateTwitchLastRequest(platformKey);
        return [connection, undefined];
    }

    try {
        // For user lookup, first try with User Access Token if available
        // This works for both public data and authenticated endpoints
        let user: TwitchUser | null = null;
        
        if (accessToken) {
            console.log(`Using User Access Token to fetch user info for ${streamerId}...`);
            user = await getTwitchUser(accessToken, clientId, streamerId);
            if (!user) {
                console.log(`User Access Token failed for ${streamerId}, trying Client Credentials...`);
            }
        }
        
        // If User Access Token failed or not provided, try with App Token (Client Credentials)
        // Note: The /users endpoint is public data and should work with Client Credentials
        if (!user) {
            const appToken = await getTwitchOAuthToken(clientId, clientSecret);
            if (appToken) {
                user = await getTwitchUser(appToken, clientId, streamerId);
            }
        }
        
        if (!user) {
            return [undefined, `Failed to fetch Twitch user "${streamerId}". The user may not exist, or the Twitch API may require different authentication.`];
        }

        const broadcasterId = user.id;

        // Create connection
        connection = {
            disconnect: () => { /* noop */ },
            platform: 'twitch_official',
            broadcasterId,
            clientId,
            clientSecret,
            accessToken: accessToken || undefined,
        } as any;

        streamerIdToTwitchOfficialConnectionMap[platformKey] = connection;
        updateTwitchLastRequest(platformKey);

        // Store accessToken for use in poll closure
        const storedAccessToken = accessToken;

        // Start polling for followers
        const poll = async () => {
            if (!shouldPollTwitch(platformKey)) {
                return;
            }

            if (pollInProgressMap[platformKey]) {
                setTimeout(poll, POLL_INTERVAL_MS);
                return;
            }

            pollInProgressMap[platformKey] = true;

            try {
                // Reuse access token if available, otherwise get new Client Credentials token
                let currentToken: string | null = storedAccessToken || null;
                if (!currentToken) {
                    currentToken = await getTwitchOAuthToken(clientId, clientSecret);
                }
                if (currentToken) {
                    await pollTwitchFollowers(currentToken, clientId, broadcasterId, platformKey);
                }
            } catch (err) {
                console.error('Poll error:', err);
            } finally {
                pollInProgressMap[platformKey] = false;
            }

            if (streamerIdToTwitchOfficialConnectionMap[platformKey]) {
                setTimeout(poll, POLL_INTERVAL_MS);
            }
        };

        poll();

        // Notify connected
        const tokenSource = accessToken ? 'access_token' : 'client_credentials';
        streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
            socket.emit('streamConnected', {
                platform: 'twitch',
                state: { connected: true, broadcasterId, userId: user.id, followersOnly: true, tokenSource }
            });
        });

        return [connection, undefined];
    } catch (err: any) {
        const errStr = err.toString();
        console.log('Twitch Official ERROR: ', errStr);
        return [undefined, errStr];
    }
};

export const disconnectTwitchOfficial = (platformKey: string) => {
    const connection = streamerIdToTwitchOfficialConnectionMap[platformKey];
    if (connection) {
        streamerIdToTwitchOfficialConnectionMap[platformKey] = undefined;
        delete pollInProgressMap[platformKey];
        delete lastFollowerCache[platformKey];

        // Notify disconnected
        streamerIdToSocketsMap[platformKey]?.forEach((socket) => {
            socket.emit('streamDisconnected', { platform: 'twitch', reason: 'Official API client disconnected' });
        });
    }
};

export { twitchOfficialUserBaseData };
