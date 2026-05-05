// Ephemeral key material for the E2EE group-key handoff.
//
// Each browser session generates a fresh X25519 keypair. The public half is
// shared via the signaling server (in CreateRoom/JoinRoom payloads, then in
// peer_joined events). To deliver the group key to a new peer, an existing
// peer:
//   1. ECDHs its private key with the new peer's public key
//   2. Derives an AES-GCM key via HKDF over the shared secret
//   3. Encrypts the 32-byte group key under that AES key
//   4. Sends {ephemeralPublicKey, iv, ciphertext} via the signaling channel
// The new peer reverses this with its private key.

const HKDF_INFO = new TextEncoder().encode("wisp/v1 group-key wrap");

export interface EphemeralKeypair {
  publicKey: string; // base64 raw
  // privateKey is non-extractable; used only for derivation.
  privateKey: CryptoKey;
}

// generateEphemeralKeypair produces a fresh X25519 ECDH keypair. The private
// half is non-extractable; the public half is exported for the wire.
export async function generateEphemeralKeypair(): Promise<EphemeralKeypair> {
  const pair = await crypto.subtle.generateKey(
    { name: "X25519" } as EcKeyGenParams,
    false,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKey: bytesToB64(new Uint8Array(raw)),
    privateKey: pair.privateKey,
  };
}

// generateGroupKey returns 32 random bytes for use as the room's group key.
// Stored only in memory by callers; never sent in plaintext.
export function generateGroupKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

// wrapGroupKey encrypts groupKey to recipientPubKey, returning the wire
// payload (base64-encoded fields). senderPair is the local peer's ephemeral
// keypair.
export async function wrapGroupKey(
  senderPair: EphemeralKeypair,
  recipientPubKey: string,
  groupKey: Uint8Array,
): Promise<{ ephemeralPublicKey: string; iv: string; ciphertext: string }> {
  const recipient = await importPublicKey(recipientPubKey);
  const aesKey = await deriveAesKey(senderPair.privateKey, recipient);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, groupKey as BufferSource);
  return {
    ephemeralPublicKey: senderPair.publicKey,
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ct)),
  };
}

// unwrapGroupKey decrypts a wrapped group key delivered by senderPubKey.
export async function unwrapGroupKey(
  recipientPair: EphemeralKeypair,
  senderPubKey: string,
  iv: string,
  ciphertext: string,
): Promise<Uint8Array> {
  const sender = await importPublicKey(senderPubKey);
  const aesKey = await deriveAesKey(recipientPair.privateKey, sender);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv) as BufferSource },
    aesKey,
    b64ToBytes(ciphertext) as BufferSource,
  );
  return new Uint8Array(pt);
}

async function importPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    b64ToBytes(b64) as BufferSource,
    { name: "X25519" } as EcKeyAlgorithm,
    false,
    [],
  );
}

async function deriveAesKey(priv: CryptoKey, pub: CryptoKey): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: pub } as unknown as Algorithm,
    priv,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: HKDF_INFO,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
