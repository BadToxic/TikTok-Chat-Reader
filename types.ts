import type { StreamEvent, StreamEvents } from './events.model.js';
import { TikTokConnectionWrapper } from './connectionWrapper.js';
import tmi from 'tmi.js';
import { Server } from 'socket.io';

// Platform-specific key (platform:streamerId)
export const getPlatformKey = (platform: 'tiktok' | 'twitch', streamerId: string): string => {
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

// Socket also stores platform info
export const socketToPlatformMap: { [key: string]: 'tiktok' | 'twitch' } = {};

// Socket.io server instance (will be set by server.ts)
export let io: Server;

export function setIo(server: Server) {
    io = server;
}

export const createInitialEventContainer = () => ({ events: [] as StreamEvent[] });
