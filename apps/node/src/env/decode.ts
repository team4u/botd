/**
 * 分块解码：与一次性 `new TextDecoder().decode(bytes)` 的结果完全一致（含 BOM 处理）。
 * 移植自 @earendil-works/pi-durable@1.5.0 dist/env/decode.js，仅用 Web 标准 TextDecoder。
 */

/** 字节区间的流式解码器；从文件开头解码的调用方需自行跳过前导 BOM。 */
export function rangeDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

/** 整体解码时是否会丢弃前三个字节的字节序标记（EF BB BF）。 */
export function startsWithBom(firstBytes: Uint8Array): boolean {
  return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/** 按块解码一个流，结果与一次性解码完全一致。 */
export class StreamDecoder {
  readonly #decoder = rangeDecoder();
  #started = false;

  /** `bytes` 对应的文本（保留未完成的字符）；不传 `bytes` 表示流结束。 */
  decode(bytes?: Uint8Array): string {
    const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
    if (this.#started || text === '') return text;
    this.#started = true;
    // U+FEFF 只能编码为 EF BB BF，因此流首的 U+FEFF 就是字节序标记。
    return text.startsWith('﻿') ? text.slice(1) : text;
  }
}
