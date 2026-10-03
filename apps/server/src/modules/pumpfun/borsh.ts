import bs58 from "bs58";

/**
 * Minimal Borsh reader for Anchor event payloads.
 * `remaining` lets decoders stop gracefully when older event versions lack trailing fields.
 */
export class BorshReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(`borsh: need ${n} bytes at ${this.offset}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new RangeError(`borsh: invalid bool ${v}`);
    return v === 1;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }

  i128(): bigint {
    const lo = this.u64();
    const hi = this.i64();
    return (hi << 64n) | lo;
  }

  pubkey(): string {
    this.need(32);
    const bytes = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return bs58.encode(bytes);
  }

  string(maxLen = 10_000): string {
    const len = this.u32();
    if (len > maxLen) throw new RangeError(`borsh: string too long (${len})`);
    this.need(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }

  vec<T>(item: (r: BorshReader) => T, maxLen = 10_000): T[] {
    const len = this.u32();
    if (len > maxLen) throw new RangeError(`borsh: vec too long (${len})`);
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(item(this));
    return out;
  }
}
