import type { StreamEvent, StreamEvents } from './events.model.js';
import { TikTokConnectionWrapper } from './connectionWrapper.js';
import tmi from 'tmi.js';
import { Server } from 'socket.io';

// Platform-specific key (platform:streamerId)
export const getPlatformKey = (platform: 'tiktok' | 'twitch' | 'youtube', streamerId: string): string => {
    return `${platform}:${streamerId.toLowerCase()}`;
};

// Keep events for 30 minutes
export const DELETE_EVENTS_AGE = 30 * 60 * 1000;

// Store events per platform-specific key (platform:streamerId)
export const streamEvents: StreamEvents = {};

// Remember the last time a request was made of each requester
export const requesterIdToLastRequestTimestamp: { [key: string]: number } = {};

// Maps using platform-specific keys (platform:streamerId)
export const streamerIdToSocketsMap: { [key: string]: any[] } = {};
export const socketToPlatformKeyMap: { [key: string]: string } = {};

// TikTok connection maps - Keys are platform:streamerId
export const streamerIdToTikTokConnectionWrapperMap: { [key: string]: TikTokConnectionWrapper | undefined } = {};

// Twitch connection maps - Keys are platform:streamerId
export const streamerIdToTwitchClientMap: { [key: string]: tmi.Client | undefined } = {};

// Twitch official API (Followers) connection map
export interface TwitchOfficialConnection {
    broadcasterId: string;
    clientId: string;
    clientSecret: string;
}
export const streamerIdToTwitchOfficialConnectionMap: { [key: string]: TwitchOfficialConnection | undefined } = {};

// YouTube connection maps - Keys are platform:streamerId
export interface YouTubeConnection {
    apiKey: string;
    intervalId?: NodeJS.Timeout;
    isConnected: boolean;
    lastRequestTimestamp: number;
    videoId: string;
    liveChatId: string;
}
export const streamerIdToYouTubeConnectionMap: { [key: string]: YouTubeConnection | undefined } = {};

// Track last request time for YouTube polling管理与自动断开
export const streamerIdToYouTubeLastRequestMap: { [key: string]: number } = {};

// Socket also stores platform info
export const socketToPlatformMap: { [key: string]: 'tiktok' | 'twitch' | 'youtube' } = {};

// Socket.io server instance (will be set by server.ts)
export let io: Server;

export function setIo(server: Server) {
    io = server;
}

export const createInitialEventContainer = () => ({ events: [] as StreamEvent[] });
