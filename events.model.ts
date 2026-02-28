export interface UserBaseData {
    userId: string;
    uniqueId: string;
    nickname?: string;
    profilePictureUrl?: string;
}

export interface LiveIntroEvent {
    type: 'liveIntro';
    timestamp: number;
    data: {
        description: string;
    };
}

export interface RoomUserEvent {
    type: 'roomUser';
    timestamp: number;
    data: {
        viewerCount: number;
    };
}

export interface LikeEvent {
    type: 'like';
    timestamp: number;
    data: {
        likeCount: number;
        totalLikeCount: number;
        user: UserBaseData;
    };
}

export interface ChatEvent {
    type: 'chat';
    timestamp: number;
    data: {
        comment: string;
        contentLanguage: string;
        user: UserBaseData;
    };
}

export interface GiftEvent {
    type: 'gift';
    timestamp: number;
    data: {
        giftId: number;
        giftName: string;
        giftType: number;
        giftPictureUrl: string;
        repeatCount: number;
        diamondCount: number;
        user: UserBaseData;
    };
}

export interface MemberEvent {
    type: 'member';
    timestamp: number;
    data: {
        memberCount: number;
        user: UserBaseData;
    };
}

export interface ShareEvent {
    type: 'share';
    timestamp: number;
    data: {
        shareCount: number;
        user: UserBaseData;
    };
}

export interface FollowEvent {
    type: 'follow';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

export interface SubscribeEvent {
    type: 'subscribe';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

export interface SuperFanEvent {
    type: 'superFan';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

export interface StreamEndEvent {
    type: 'streamEnd';
    timestamp: number;
    data: any;
}

export type StreamEvent = LiveIntroEvent | RoomUserEvent | LikeEvent | ChatEvent | GiftEvent | MemberEvent | ShareEvent | FollowEvent | SubscribeEvent | SuperFanEvent | StreamEndEvent | { type: string; data: any; timestamp: number };

export type StreamEvents = { [key: string]: { events: StreamEvent[] } }