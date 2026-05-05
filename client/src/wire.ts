// Wire types mirroring the Go signaling server's internal/wire package. Field
// names match the JSON form. Keep this file in sync if the server changes.

export type ServerEnvelope =
  | { type: "room_created"; payload: RoomCreated }
  | { type: "room_joined"; payload: RoomJoined }
  | { type: "peer_joined"; payload: PeerJoined }
  | { type: "peer_left"; payload: PeerLeft }
  | { type: "peer_renamed"; payload: PeerRenamed }
  | { type: "signal"; payload: SignalForwarded }
  | { type: "error"; payload: ErrorPayload };

export type ClientEnvelope =
  | { type: "create_room"; payload: { publicKey: string; supportsE2EE: boolean; name: string } }
  | { type: "join_room"; payload: { code: string; publicKey: string; supportsE2EE: boolean; name: string } }
  | { type: "leave_room"; payload: Record<string, never> }
  | { type: "rename"; payload: { name: string } }
  | { type: "signal"; payload: { to: string; data: SignalData } };

export interface PeerInfo {
  id: string;
  publicKey: string;
  supportsE2EE: boolean;
  name: string;
}

export interface TurnCreds {
  uris: string[];
  username: string;
  credential: string;
  ttl: number;
}

export interface RoomCreated {
  code: string;
  peerId: string;
  name: string;
  turn?: TurnCreds | null;
}

export interface RoomJoined {
  code: string;
  peerId: string;
  name: string;
  peers: PeerInfo[];
  turn?: TurnCreds | null;
}

export interface PeerJoined {
  peerId: string;
  publicKey: string;
  supportsE2EE: boolean;
  name: string;
}

export interface PeerLeft {
  peerId: string;
}

export interface PeerRenamed {
  peerId: string;
  name: string;
}

export const MAX_NAME_LEN = 32;

export interface SignalForwarded {
  from: string;
  data: SignalData;
}

// SignalData is opaque to the server and carries any of:
//   - WebRTC SDP offers/answers
//   - WebRTC ICE candidates
//   - Wrapped E2EE group keys
//   - Screen-share status announcements (advisory; the actual track flow
//     is the WebRTC video track on the same RTCPeerConnection)
// The discriminator is the `kind` field. New kinds are additive — older clients
// ignore unknown kinds.
export type SignalData =
  | { kind: "sdp"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "key"; epoch: number; ephemeralPublicKey: string; iv: string; ciphertext: string }
  // streamId is the MediaStream ID the sender will use for both the video
  // and any system-audio track, so the receiver can classify a second
  // inbound audio track as screen-audio (different IV tag) rather than
  // misclassifying it as a second mic.
  | { kind: "screen"; on: boolean; streamId?: string };

export interface ErrorPayload {
  code: string;
  message?: string;
}

export const ErrCodes = {
  RoomNotFound: "room_not_found",
  RoomFull: "room_full",
  RateLimited: "rate_limited",
  BadRequest: "bad_request",
  Capacity: "capacity",
  PeerNotFound: "peer_not_found",
  Internal: "internal",
} as const;
