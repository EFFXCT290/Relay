import type {
  RTCSessionDescriptionInitLike,
  RTCIceCandidateInitLike,
  CallIceCandidateType,
} from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// WebRTC controller — owns the RTCPeerConnection, media streams, ICE and SDP.
// React components NEVER touch any of this; they go through CallProvider, which
// holds one controller per call in a ref. Keeping the peer connection out of the
// component tree avoids renegotiation/teardown bugs on re-render.
//
// One controller = one call. After close() it is dead; the provider makes a
// fresh one for the next call. close() is the single mic-releasing teardown.
// ─────────────────────────────────────────────────────────────────────────────

// Fallback used only until call signaling delivers the real config (STUN + a
// per-call TURN relay) via setIceServers(). A direct/STUN path is better than
// nothing if a payload ever arrives without servers.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 1080p / 30fps ideal — the browser negotiates down on weaker links, so this is
// a ceiling, not a floor. Adaptive bitrate (the old 6D Step 3) is still
// deferred — relying on the browser's automatic degradation for now.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width:      { ideal: 1920 },
  height:     { ideal: 1080 },
  frameRate:  { ideal: 30, max: 60 },
  facingMode: "user",
};

// 1080p60 ideal for screen share — "ideal" (not "exact"/"min") so the browser
// still negotiates down instead of failing outright when the source can't
// provide it. No custom bandwidth throttling here, same rationale as
// VIDEO_CONSTRAINTS above: the browser's own WebRTC congestion control already
// measures live bandwidth and adapts the encoder — a hand-rolled ceiling would
// just fight it.
const SCREEN_SHARE_CONSTRAINTS: MediaTrackConstraints = {
  width:     { ideal: 1920 },
  height:    { ideal: 1080 },
  frameRate: { ideal: 60, max: 60 },
};

// Observability only (Part 3) — periodic pc.getStats() summary while a call is
// live. 7s: within the 5-10s window asked for, and distinct from
// ICE_DISCONNECT_GRACE_MS (call-provider.tsx) so the two aren't mistaken for
// the same knob.
export const CONNECTION_STATS_INTERVAL_MS = 7_000;

export type ConnectionStatsSummary = {
  candidateType:      CallIceCandidateType;
  bytesSentDelta:     number; // since the previous report, not cumulative
  bytesReceivedDelta: number;
  packetLoss?:        number;
};

export type WebRtcCallbacks = {
  onIceCandidate:    (candidate: RTCIceCandidateInitLike) => void;
  onLocalStream:     (stream: MediaStream) => void;
  onRemoteStream:    (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  // Fires after the initial getUserMedia and after every successful flip, so the
  // UI knows whether to mirror the self-preview (front camera) or not (rear).
  onFacingChange:    (facing: "user" | "environment") => void;
  // Fires every CONNECTION_STATS_INTERVAL_MS once the call is connected. Pure
  // observability — the caller (call-provider.tsx) reports it for logging only
  // and must never let it affect the call.
  onConnectionStats: (summary: ConnectionStatsSummary) => void;
  // Fires when the PEER's screen-share track(s) arrive — a distinct MediaStream
  // from onRemoteStream's camera+mic bundle (see ontrack below for how the two
  // are told apart). There is no matching "removed" callback: the caller learns
  // a share ended via the explicit call:media-state signal, not by polling this
  // stream for dead tracks.
  onRemoteScreenStream: (stream: MediaStream) => void;
  // Fires when the LOCAL screen share ends via the browser's own native "Stop
  // sharing" bar (getDisplayMedia()'s track "ended" event) rather than the
  // in-app button — the caller must still run the same teardown/renegotiation
  // as an explicit stopScreenShare() call.
  onScreenShareEnded: () => void;
};

export class WebRtcController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private hasRemoteDesc = false;
  private pendingIce: RTCIceCandidateInitLike[] = [];
  private closed = false;
  private facingMode: "user" | "environment" = "user";
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  // Cumulative totals as of the last report — every emitted summary is a delta
  // against these, not the raw cumulative counters getStats() returns.
  private lastBytesSent = 0;
  private lastBytesReceived = 0;
  // Screen share (additive track, never a replaceTrack swap of the camera).
  private localScreenStream: MediaStream | null = null;
  private remoteScreenStream: MediaStream | null = null;
  // Which session's stream id remoteScreenStream currently accumulates. A
  // sender that has ever sent (currentDirection sendonly/sendrecv) can never
  // be reused by a later addTrack() (MDN's addTrack spec), so every
  // stop-then-restart mints a genuinely new transceiver/stream id — never the
  // previous session's. Tracked here so ontrack (below) can tell "another
  // track of THIS session" (keep accumulating) apart from "a NEW session"
  // (start fresh) — without it, a restarted share's live track would land in
  // the same MediaStream as the previous session's now-permanently-muted one,
  // and since a <video> only ever renders the FIRST video track a stream ever
  // held, the element stays stuck on the dead one.
  private remoteScreenStreamId: string | null = null;
  // ontrack fires once per incoming stream. The FIRST stream id ever seen is
  // the camera+mic bundle established at call setup; any track that later
  // arrives on a DIFFERENT stream id is the peer's screen share. Only two
  // stream identities are ever in play (camera bundle, screen bundle), so this
  // arrival-order heuristic is enough to route without a dedicated SDP marker.
  private primaryRemoteStreamId: string | null = null;

  constructor(private cb: WebRtcCallbacks) {}

  // Install the ICE config (STUN + the per-call TURN relay) delivered via call
  // signaling. MUST be called before the first negotiation — the peer connection
  // is created lazily in createOffer/acceptOffer so the config is baked in at
  // construction and never needs a mid-call setConfiguration. No-ops on an empty
  // list so a missing-TURN payload can't clobber the STUN fallback.
  setIceServers(servers: RTCIceServer[] | null | undefined): void {
    if (servers && servers.length > 0) this.iceServers = servers;
  }

  // Acquire the mic (and camera for video calls). Tracks are attached to the peer
  // connection lazily when it's created (see ensurePc) — that lets setIceServers
  // run in between, after the relay config arrives from signaling. Throws if
  // permission is denied — the caller must close() and abort the call.
  async startLocalMedia(opts: { video: boolean }): Promise<void> {
    if (this.localStream || this.closed) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: opts.video ? VIDEO_CONSTRAINTS : false,
    });
    this.cb.onLocalStream(this.localStream);
    // facingMode defaults to "user" via VIDEO_CONSTRAINTS; mirror that to the UI
    // for video calls so the self-preview mirrors correctly from the first frame.
    if (opts.video) this.cb.onFacingChange(this.facingMode);
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.remoteStream = new MediaStream();

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.closed) this.cb.onIceCandidate(e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      if (this.closed || !this.remoteStream) return;
      const stream = e.streams[0];
      const isScreenShare = !!stream && this.primaryRemoteStreamId !== null && stream.id !== this.primaryRemoteStreamId;
      if (stream && this.primaryRemoteStreamId === null) this.primaryRemoteStreamId = stream.id;

      if (isScreenShare) {
        // stream.id changing means a NEW session (see remoteScreenStreamId's
        // comment) — start a clean accumulator so the previous session's dead
        // track can never linger as the stream's first (and thus rendered)
        // video track. Same stream.id (e.g. the video-then-audio firings of
        // ONE session) keeps mutating the existing object in place, which
        // attachStream()'s identity guard (call-provider.tsx) treats as a
        // no-op — avoiding an srcObject reassignment per track arrival.
        if (!this.remoteScreenStream || this.remoteScreenStreamId !== stream.id) {
          this.remoteScreenStream = new MediaStream();
          this.remoteScreenStreamId = stream.id;
        }
        for (const t of stream.getTracks()) this.remoteScreenStream.addTrack(t);
        this.cb.onRemoteScreenStream(this.remoteScreenStream);
        return;
      }
      const tracks = stream?.getTracks() ?? [e.track];
      for (const t of tracks) this.remoteStream.addTrack(t);
      this.cb.onRemoteStream(this.remoteStream);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.cb.onConnectionState(pc.connectionState);
      // Start once, on the first real connection — no point polling stats for
      // a pc that was never up, and this must never restart on a later
      // reconnect (that would reset the delta baseline mid-call).
      if (pc.connectionState === "connected" && !this.statsTimer) {
        this.statsTimer = setInterval(() => { void this.reportStats(); }, CONNECTION_STATS_INTERVAL_MS);
      }
    };

    this.pc = pc;
    // startLocalMedia runs before any negotiation, so the stream is already here;
    // attach its tracks now that the pc exists (deferred so the ICE config could
    // be applied first). These must be added before createOffer/createAnswer to
    // make it into the SDP.
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    return pc;
  }

  // Returns null if a negotiation is already in flight (signalingState isn't
  // "stable") — the caller (call-provider) just skips that emit. This is a
  // guard against glare, not full perfect-negotiation rollback: matches the
  // existing convention of avoiding renegotiation collisions rather than fully
  // resolving them (see the ICE-restart comment in call-provider.tsx — only the
  // "outgoing" side drives that one for the same reason). Two humans on a call
  // starting a mid-call renegotiation (screen share, ICE restart) in the exact
  // same tick is rare enough that a dropped, retriable attempt is an acceptable
  // trade for not carrying full offer/answer rollback machinery.
  async createOffer(): Promise<RTCSessionDescriptionInitLike | null> {
    const pc = this.ensurePc();
    if (pc.signalingState !== "stable") return null;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return { type: "offer", sdp: offer.sdp };
  }

  // Returns null when we ourselves have a pending local offer (the glare case
  // above, from the answering side) — see createOffer()'s comment. Dropping the
  // incoming offer here is safe: the in-flight offer/answer this side already
  // started will still resolve on its own.
  async acceptOffer(sdp: RTCSessionDescriptionInitLike): Promise<RTCSessionDescriptionInitLike | null> {
    const pc = this.ensurePc();
    if (pc.signalingState === "have-local-offer") return null;
    await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
    await this.flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { type: "answer", sdp: answer.sdp };
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInitLike): Promise<void> {
    if (!this.pc || this.closed) return;
    await this.pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
    await this.flushPendingIce();
  }

  // ICE may arrive before the remote description is set; buffer until it is,
  // otherwise addIceCandidate throws and candidates are silently lost.
  async addIce(candidate: RTCIceCandidateInitLike): Promise<void> {
    if (!this.pc || this.closed) return;
    if (!this.hasRemoteDesc) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch {
      /* late / duplicate candidate — safe to ignore */
    }
  }

  private async flushPendingIce(): Promise<void> {
    this.hasRemoteDesc = true;
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) {
      try {
        await this.pc?.addIceCandidate(c as RTCIceCandidateInit);
      } catch {
        /* ignore */
      }
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  // Camera on/off without dropping the sender — disabling keeps the track in the
  // connection (remote sees black), so it's instant and reversible.
  setCameraEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = enabled;
  }

  // Mark the ICE agent for a fresh restart (new ufrag/pwd) on the *next*
  // offer/answer — this alone does not renegotiate. The caller must follow up
  // with createOffer()/createAnswer() and send it through signaling for the
  // restart to actually take effect.
  restartIce(): void {
    if (!this.pc || this.closed) return;
    this.pc.restartIce();
  }

  // Best-effort observability (Part 3) — reads the currently-selected candidate
  // pair and inbound packet counters, diffs bytes against the last report, and
  // hands a slim summary to the caller. Any failure here (a browser quirk in
  // getStats(), a closed pc mid-call) is swallowed: this must never affect the
  // actual call.
  private async reportStats(): Promise<void> {
    if (!this.pc || this.closed) return;
    try {
      const report = await this.pc.getStats();
      const summary = summarizeStats(report, this.lastBytesSent, this.lastBytesReceived);
      if (!summary) return;
      this.lastBytesSent = summary.totalBytesSent;
      this.lastBytesReceived = summary.totalBytesReceived;
      this.cb.onConnectionStats({
        candidateType:      summary.candidateType,
        bytesSentDelta:     summary.bytesSentDelta,
        bytesReceivedDelta: summary.bytesReceivedDelta,
        packetLoss:         summary.packetLoss,
      });
    } catch {
      /* getStats() is observability-only — never let it affect the call */
    }
  }

  // Flip front/back. replaceTrack is the authoritative network swap (no SDP
  // renegotiation); localStream is kept in sync so the self-preview reflects the
  // new camera. Exactly one video track in the stream at all times.
  async switchCamera(): Promise<void> {
    if (!this.localStream || !this.pc || this.closed) return;
    const next = this.facingMode === "user" ? "environment" : "user";

    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...VIDEO_CONSTRAINTS, facingMode: next },
      });
    } catch {
      return; // no second camera / permission denied — stay on the current one
    }
    if (this.closed) {
      for (const t of newStream.getTracks()) t.stop();
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;

    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    await sender?.replaceTrack(newTrack);

    const oldTrack = this.localStream.getVideoTracks()[0];
    if (oldTrack) {
      oldTrack.stop();
      this.localStream.removeTrack(oldTrack);
    }
    this.localStream.addTrack(newTrack);
    this.facingMode = next;
    this.cb.onLocalStream(this.localStream);
    this.cb.onFacingChange(next);
  }

  // Additive: an extra video (+ optional audio) track/transceiver on top of the
  // existing camera+mic senders, never a replaceTrack() swap. Both cameras keep
  // flowing. Caller (call-provider) is responsible for the follow-up
  // createOffer()/emitOffer() renegotiation — this only does the local media +
  // track side of it, mirroring how switchCamera() leaves signaling to its
  // caller too... except switchCamera never renegotiates (replaceTrack needs
  // none) while this always does, since adding a track changes the SDP.
  //
  // Throws if getDisplayMedia is denied/cancelled or there's no active call —
  // caller must catch and treat it as "share didn't start," not a call error.
  async startScreenShare(): Promise<MediaStream> {
    if (!this.pc || this.closed) throw new Error("no active call to share a screen into");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: SCREEN_SHARE_CONSTRAINTS,
      audio: true,
    });
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("call closed while requesting the screen share");
    }
    this.localScreenStream = stream;
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
      // Only the video track reflects the OS-level "Stop sharing" bar — audio
      // capture (when granted) ends alongside it, not independently.
      if (track.kind === "video") {
        track.onended = () => {
          void this.stopScreenShare();
          this.cb.onScreenShareEnded();
        };
      }
    }
    return stream;
  }

  // Removes the screen-share sender(s) and stops the local capture. Caller is
  // responsible for the follow-up renegotiation, same as startScreenShare().
  // Safe to call when nothing is being shared (no-op) — both the in-app button
  // and the native "Stop sharing" bar's ended-track handler above call this.
  async stopScreenShare(): Promise<void> {
    if (!this.pc || !this.localScreenStream) return;
    const stream = this.localScreenStream;
    this.localScreenStream = null;
    for (const track of stream.getTracks()) {
      const sender = this.pc.getSenders().find((s) => s.track === track);
      if (sender) this.pc.removeTrack(sender);
      track.onended = null;
      track.stop();
    }
  }

  // Idempotent full teardown. Stops EVERY local track (releases the mic), stops
  // remote tracks, detaches handlers, and closes the peer connection. This is
  // the one routine that guarantees no leaked microphone and no ghost pc.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
    for (const track of this.localScreenStream?.getTracks() ?? []) track.stop();
    for (const track of this.remoteScreenStream?.getTracks() ?? []) track.stop();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.localScreenStream = null;
    this.remoteScreenStream = null;
    this.remoteScreenStreamId = null;
    this.pendingIce = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsing of an RTCStatsReport into the slim shape Part 3 reports. Exported
// standalone (rather than inlined in reportStats()) so it's unit-testable
// against a hand-built fake report — no real getStats()/RTCPeerConnection
// needed, same rationale as the fakes in webrtc.test.ts.
//
// Bytes/candidate-type come from the currently-selected ("succeeded",
// nominated) candidate pair — exactly "the current candidate pair", per spec.
// Packet loss is approximated from summed inbound-rtp packetsLost/packetsReceived
// across all m-lines (audio + video), since candidate-pair stats don't carry
// loss directly. Returns null when there's no succeeded pair yet (e.g. very
// early in negotiation) — reportStats() just skips that tick.
// ─────────────────────────────────────────────────────────────────────────────
export function summarizeStats(
  report: RTCStatsReport,
  prevBytesSent: number,
  prevBytesReceived: number,
): {
  candidateType:      CallIceCandidateType;
  bytesSentDelta:     number;
  bytesReceivedDelta: number;
  packetLoss?:        number;
  totalBytesSent:     number;
  totalBytesReceived: number;
} | null {
  const byId = new Map<string, Record<string, unknown>>();
  let pair: Record<string, unknown> | null = null;
  let totalPacketsLost = 0;
  let totalPacketsReceived = 0;
  let sawInboundRtp = false;

  report.forEach((stat: Record<string, unknown>) => {
    byId.set(stat.id as string, stat);
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated !== false) {
      pair = stat;
    } else if (stat.type === "inbound-rtp" && !stat.isRemote) {
      sawInboundRtp = true;
      totalPacketsLost += (stat.packetsLost as number | undefined) ?? 0;
      totalPacketsReceived += (stat.packetsReceived as number | undefined) ?? 0;
    }
  });
  if (!pair) return null;

  const activePair = pair as Record<string, unknown>;
  let candidateType: CallIceCandidateType = "unknown";
  const localId = activePair.localCandidateId as string | undefined;
  const local = localId ? byId.get(localId) : undefined;
  if (typeof local?.candidateType === "string") candidateType = local.candidateType as CallIceCandidateType;

  const totalBytesSent = (activePair.bytesSent as number | undefined) ?? 0;
  const totalBytesReceived = (activePair.bytesReceived as number | undefined) ?? 0;
  const lossDenominator = totalPacketsLost + totalPacketsReceived;

  return {
    candidateType,
    // Math.max(0, …) guards a candidate-pair switch mid-call: the newly
    // selected pair's cumulative counters legitimately start below the
    // previous pair's, which must read as "no data yet", not negative traffic.
    bytesSentDelta:     Math.max(0, totalBytesSent - prevBytesSent),
    bytesReceivedDelta: Math.max(0, totalBytesReceived - prevBytesReceived),
    packetLoss:         sawInboundRtp && lossDenominator > 0 ? totalPacketsLost / lossDenominator : undefined,
    totalBytesSent,
    totalBytesReceived,
  };
}
