import { type Static } from "@sinclair/typebox";
export type Presence = Static<typeof PresenceSchema>;
export declare const PresenceSchema: import("@sinclair/typebox").TObject<{
    userId: import("@sinclair/typebox").TString;
    isOnline: import("@sinclair/typebox").TBoolean;
    lastSeen: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const PRESENCE_EVENTS: {
    readonly ONLINE: "presence:online";
    readonly OFFLINE: "presence:offline";
    readonly PING: "presence:ping";
    readonly SYNC_REQUEST: "presence:sync-request";
    readonly SYNC_RESPONSE: "presence:sync-response";
};
export type PresenceEventName = (typeof PRESENCE_EVENTS)[keyof typeof PRESENCE_EVENTS];
export declare const PRESENCE_PING_INTERVAL_MS = 10000;
export declare const PRESENCE_HEARTBEAT_TTL_S = 30;
export declare const PRESENCE_GRACE_MS: number;
export declare const PRESENCE_LASTSEEN_DB_THROTTLE_S = 60;
export type PresenceOnlineEvent = {
    userId: string;
};
export type PresenceOfflineEvent = {
    userId: string;
    lastSeen: string;
};
export type PresenceSyncRequest = {
    userIds: string[];
};
export type PresenceSyncResponse = {
    users: Array<{
        userId: string;
        isOnline: boolean;
        lastSeen: string | null;
    }>;
};
