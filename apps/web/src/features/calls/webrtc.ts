import type {
  RTCSessionDescriptionInitLike,
  RTCIceCandidateInitLike,
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

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// 1080p / 30fps ideal — the browser negotiates down on weaker links, so this is
// a ceiling, not a floor. Adaptive bitrate (the old 6D Step 3) is still
// deferred — relying on the browser's automatic degradation for now.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width:      { ideal: 1920 },
  height:     { ideal: 1080 },
  frameRate:  { ideal: 30, max: 60 },
  facingMode: "user",
};

export type WebRtcCallbacks = {
  onIceCandidate:    (candidate: RTCIceCandidateInitLike) => void;
  onLocalStream:     (stream: MediaStream) => void;
  onRemoteStream:    (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  // Fires after the initial getUserMedia and after every successful flip, so the
  // UI knows whether to mirror the self-preview (front camera) or not (rear).
  onFacingChange:    (facing: "user" | "environment") => void;
};

export class WebRtcController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private hasRemoteDesc = false;
  private pendingIce: RTCIceCandidateInitLike[] = [];
  private closed = false;
  private facingMode: "user" | "environment" = "user";

  constructor(private cb: WebRtcCallbacks) {}

  // Acquire the mic (and camera for video calls) and attach the tracks. Throws if
  // permission is denied — the caller must close() and abort the call.
  async startLocalMedia(opts: { video: boolean }): Promise<void> {
    if (this.localStream || this.closed) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: opts.video ? VIDEO_CONSTRAINTS : false,
    });
    const pc = this.ensurePc();
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    this.cb.onLocalStream(this.localStream);
    // facingMode defaults to "user" via VIDEO_CONSTRAINTS; mirror that to the UI
    // for video calls so the self-preview mirrors correctly from the first frame.
    if (opts.video) this.cb.onFacingChange(this.facingMode);
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteStream = new MediaStream();

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.closed) this.cb.onIceCandidate(e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      if (this.closed || !this.remoteStream) return;
      const tracks = e.streams[0]?.getTracks() ?? [e.track];
      for (const t of tracks) this.remoteStream.addTrack(t);
      this.cb.onRemoteStream(this.remoteStream);
    };
    pc.onconnectionstatechange = () => {
      if (!this.closed) this.cb.onConnectionState(pc.connectionState);
    };

    this.pc = pc;
    return pc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInitLike> {
    const pc = this.ensurePc();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return { type: "offer", sdp: offer.sdp };
  }

  async acceptOffer(sdp: RTCSessionDescriptionInitLike): Promise<RTCSessionDescriptionInitLike> {
    const pc = this.ensurePc();
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

  // Idempotent full teardown. Stops EVERY local track (releases the mic), stops
  // remote tracks, detaches handlers, and closes the peer connection. This is
  // the one routine that guarantees no leaked microphone and no ghost pc.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingIce = [];
  }
}
