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

export type WebRtcCallbacks = {
  onIceCandidate:    (candidate: RTCIceCandidateInitLike) => void;
  onRemoteStream:    (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
};

export class WebRtcController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private hasRemoteDesc = false;
  private pendingIce: RTCIceCandidateInitLike[] = [];
  private closed = false;

  constructor(private cb: WebRtcCallbacks) {}

  // Acquire the mic and attach its track. Throws if permission is denied — the
  // caller must close() and abort the call.
  async startLocalAudio(): Promise<void> {
    if (this.localStream || this.closed) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const pc = this.ensurePc();
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
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
