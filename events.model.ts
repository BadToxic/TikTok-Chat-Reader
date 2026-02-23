interface UserBaseData {
    userId: string;
    uniqueId: string;
    nickname: string;
    profilePictureUrl: string;
}

interface LiveIntroEvent {
    type: 'liveIntro';
    timestamp: number;
    data: {
        description: string;
    };
}

interface RoomUserEvent {
    type: 'roomUser';
    timestamp: number;
    data: {
        viewerCount: number;
    };
}

interface LikeEvent {
    type: 'like';
    timestamp: number;
    data: {
        likeCount: number;
        totalLikeCount: number;
        user: UserBaseData;
    };
}

interface ChatEvent {
    type: 'chat';
    timestamp: number;
    data: {
        comment: string;
        contentLanguage: string;
        user: UserBaseData;
    };
}

interface GiftEvent {
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

interface MemberEvent {
    type: 'member';
    timestamp: number;
    data: {
        memberCount: number;
        user: UserBaseData;
    };
}

interface ShareEvent {
    type: 'share';
    timestamp: number;
    data: {
        shareCount: number;
        user: UserBaseData;
    };
}

interface FollowEvent {
    type: 'follow';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

interface SubscribeEvent {
    type: 'subscribe';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

interface SuperFanEvent {
    type: 'superFan';
    timestamp: number;
    data: {
        user: UserBaseData;
    };
}

interface StreamEndEvent {
    type: 'streamEnd';
    timestamp: number;
    data: any;
}

type StreamEvent = LiveIntroEvent | RoomUserEvent | LikeEvent | ChatEvent | GiftEvent | MemberEvent | ShareEvent | FollowEvent | SubscribeEvent | SuperFanEvent | StreamEndEvent | { type: string; data: any; timestamp: number };
