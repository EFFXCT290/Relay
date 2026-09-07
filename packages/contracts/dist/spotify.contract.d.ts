import { type Static } from "@sinclair/typebox";
export declare const SpotifyConnectResultSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"connected">, import("@sinclair/typebox").TLiteral<"error">]>;
export type SpotifyConnectResult = Static<typeof SpotifyConnectResultSchema>;
export declare const SpotifyBadgeSchema: import("@sinclair/typebox").TObject<{
    isPlaying: import("@sinclair/typebox").TBoolean;
    trackName: import("@sinclair/typebox").TString;
    artistName: import("@sinclair/typebox").TString;
    albumArtUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    trackUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    playedAt: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
}>;
export type SpotifyBadge = Static<typeof SpotifyBadgeSchema>;
export declare const SpotifyBadgeResponseSchema: import("@sinclair/typebox").TObject<{
    spotify: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        isPlaying: import("@sinclair/typebox").TBoolean;
        trackName: import("@sinclair/typebox").TString;
        artistName: import("@sinclair/typebox").TString;
        albumArtUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        trackUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        playedAt: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    }>, import("@sinclair/typebox").TNull]>;
}>;
export type SpotifyBadgeResponse = Static<typeof SpotifyBadgeResponseSchema>;
export declare const SpotifyConnectionStatusSchema: import("@sinclair/typebox").TObject<{
    connected: import("@sinclair/typebox").TBoolean;
    showOnProfile: import("@sinclair/typebox").TBoolean;
    needsReconnect: import("@sinclair/typebox").TBoolean;
    connectedAt: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
}>;
export type SpotifyConnectionStatus = Static<typeof SpotifyConnectionStatusSchema>;
export declare const UpdateSpotifyPreferencesPayloadSchema: import("@sinclair/typebox").TObject<{
    showOnProfile: import("@sinclair/typebox").TBoolean;
}>;
export type UpdateSpotifyPreferencesPayload = Static<typeof UpdateSpotifyPreferencesPayloadSchema>;
export declare const SpotifyConversationSummarySchema: import("@sinclair/typebox").TObject<{
    trackName: import("@sinclair/typebox").TString;
    artistName: import("@sinclair/typebox").TString;
    isPlaying: import("@sinclair/typebox").TBoolean;
}>;
export type SpotifyConversationSummary = Static<typeof SpotifyConversationSummarySchema>;
