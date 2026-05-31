import { type Static } from "@sinclair/typebox";
export declare const NotificationTypeSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"SYSTEM_ALERT">, import("@sinclair/typebox").TLiteral<"MESSAGE_RECEIVED">, import("@sinclair/typebox").TLiteral<"VIEW_COUNT_UPDATE">, import("@sinclair/typebox").TLiteral<"MEDIA_EXPIRED">]>;
export type NotificationType = Static<typeof NotificationTypeSchema>;
export type NotificationPayload = {
    capturedBy?: {
        userId: string;
        username: string;
    };
    eventType?: "SCREENSHOT_ATTEMPT" | "RECORD_ATTEMPT";
    trigger?: string;
    timestamp?: string;
    mediaId?: string;
    thumbnailUrl?: string;
    userAgent?: string;
    platform?: string;
    viewer?: {
        userId: string;
        username: string;
    };
    viewsUsed?: number;
    viewsAllowed?: number;
    messageId?: string;
    recipient?: {
        userId: string;
        username: string;
    };
    expiredAt?: string;
    from?: {
        userId: string;
        username: string;
    };
    preview?: string;
} & Record<string, unknown>;
export declare const NotificationSchema: import("@sinclair/typebox").TObject<{
    notificationId: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TString;
    isRead: import("@sinclair/typebox").TBoolean;
    payload: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
    createdAt: import("@sinclair/typebox").TString;
}>;
export type Notification = {
    notificationId: string;
    type: NotificationType | string;
    isRead: boolean;
    payload: NotificationPayload;
    createdAt: string;
};
export declare const NOTIFICATION_EVENTS: {
    readonly NEW: "notification:new";
};
export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];
export type NotificationNewEvent = {
    notification: Notification;
};
