import crypto from "node:crypto";

/**
 * AES-128-CTR keystream with the same block semantics OpenSSL's EVP_aes_128_ctr
 * exposes to UxPlay (a 128-bit big-endian counter, a per-block keystream, and a
 * byte offset within the current block). We generate the keystream ourselves
 * from AES-128-ECB over the counter so we can reproduce UxPlay's
 * `aes_ctr_start_fresh_block` exactly — Node's streaming CTR hides the offset.
 *
 * Ported from scrcpy-free reference: UxPlay lib/crypto.c (aes_ctr_*) and
 * lib/mirror_buffer.c (mirror_buffer_decrypt).
 */
export class StreamCtr {
  private counter: Buffer;
  private keystream: Buffer;
  private offset = 16; // force a fresh block on first use
  private readonly ecb: () => crypto.Cipher;

  constructor(key: Buffer, iv: Buffer) {
    if (key.length !== 16 || iv.length !== 16) throw new Error("AES-128-CTR needs a 16-byte key and IV");
    this.counter = Buffer.from(iv);
    this.keystream = Buffer.alloc(16);
    this.ecb = () => crypto.createCipheriv("aes-128-ecb", key, null).setAutoPadding(false);
  }

  private block() {
    const c = this.ecb();
    this.keystream = Buffer.concat([c.update(this.counter), c.final()]);
  }

  private inc() {
    for (let i = 15; i >= 0; i--) {
      this.counter[i] = (this.counter[i]! + 1) & 0xff;
      if (this.counter[i] !== 0) break;
    }
  }

  /** XOR len bytes of the keystream into out (CTR encrypt == decrypt). */
  crypt(input: Buffer, output: Buffer, len: number): void {
    for (let i = 0; i < len; i++) {
      if (this.offset === 16) {
        if (!this.firstBlock) this.inc();
        this.firstBlock = false;
        this.block();
        this.offset = 0;
      }
      output[i] = input[i]! ^ this.keystream[this.offset]!;
      this.offset++;
    }
  }
  private firstBlock = true;

  /** UxPlay aes_ctr_start_fresh_block: consume the rest of the current block so the next byte starts a new counter block. */
  startFreshBlock(): void {
    if (this.offset % 16 === 0) return;
    const waste = Buffer.alloc(16);
    this.crypt(waste, waste, 16 - (this.offset % 16));
  }
}

/** SHA-512(text ‖ audioKey), truncated to 16 bytes — the mirror video key/IV derivation (mirror_buffer.c). */
export function deriveStreamKey(label: "AirPlayStreamKey" | "AirPlayStreamIV", streamConnectionId: string, audioKey: Buffer): Buffer {
  const h = crypto.createHash("sha512");
  h.update(Buffer.from(`${label}${streamConnectionId}`, "ascii"));
  h.update(audioKey);
  return h.digest().subarray(0, 16);
}

/**
 * Port of UxPlay mirror_buffer_decrypt: AES-CTR over the video payload, keeping
 * the trailing partial block's keystream across packets and realigning to a
 * block boundary for the aligned middle. Stateful per mirror connection.
 */
export class MirrorDecryptor {
  private ctr: StreamCtr;
  private nextDecryptCount = 0;
  private og = Buffer.alloc(16);

  constructor(streamConnectionId: string, audioKey: Buffer) {
    const key = deriveStreamKey("AirPlayStreamKey", streamConnectionId, audioKey);
    const iv = deriveStreamKey("AirPlayStreamIV", streamConnectionId, audioKey);
    this.ctr = new StreamCtr(key, iv);
  }

  decrypt(input: Buffer): Buffer {
    const len = input.length;
    const output = Buffer.alloc(len);
    // Continue the previous packet's final partial block from the saved keystream tail.
    const carry = Math.min(len, this.nextDecryptCount);
    for (let i = 0; i < carry; i++) {
      output[i] = input[i]! ^ this.og[16 - this.nextDecryptCount + i]!;
    }
    this.nextDecryptCount -= carry;
    if (carry === len) return output;
    const encryptlen = Math.floor((len - carry) / 16) * 16;
    this.ctr.startFreshBlock();
    this.ctr.crypt(input.subarray(carry), output.subarray(carry), encryptlen);
    const restlen = (len - carry) % 16;
    const reststart = len - restlen;
    this.nextDecryptCount = 0;
    if (restlen > 0) {
      this.og.fill(0);
      input.copy(this.og, 0, reststart, reststart + restlen);
      this.ctr.crypt(this.og, this.og, 16);
      this.og.copy(output, reststart, 0, restlen);
      this.nextDecryptCount = 16 - restlen;
    }
    return output;
  }
}

/**
 * Pluggable FairPlay/key provider. A real iPhone encrypts the per-session audio
 * AES key with FairPlay; decrypting it needs Apple's playfair tables, which we
 * do not reproduce. Implementations:
 *   - TestKeyProvider: a fixed known key (used by the fake-iPhone test and any
 *     sender that negotiates no FairPlay).
 *   - A sidecar/native provider (e.g. UxPlay) supplies the real decrypted key.
 */
export interface KeyProvider {
  /** Given the SETUP ekey (FairPlay-wrapped) and eiv, return the 16-byte audio AES key, or null if unavailable. */
  decryptAudioKey(ekey: Buffer, eiv: Buffer): Buffer | null;
  /** Respond to an /fp-setup message (two phases). Return the bytes to send back, or null to refuse. */
  fpSetup?(phase: number, body: Buffer): Buffer | null;
}

/** A provider with a caller-supplied known key. Used for tests and no-FairPlay senders. */
export class TestKeyProvider implements KeyProvider {
  constructor(private readonly key: Buffer) {}
  decryptAudioKey(): Buffer {
    return this.key;
  }
  fpSetup(): Buffer {
    return Buffer.alloc(0);
  }
}
