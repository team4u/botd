/**
 * 流式行扫描：以有界内存计算任意大小文件的 LineScan。
 * 移植自 @earendil-works/pi-durable@1.5.0 dist/env/line-scan.js。
 */

import { rangeDecoder, startsWithBom } from './decode.js';

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

/** 解码后文本的 UTF-8 字节长度。 */
function decodedBytes(text: string): number {
  return text === '' ? 0 : encoder.encode(text).length;
}

/**
 * 按顺序喂入文件字节，最终产出 `LineScan`。
 * 解码尺寸使用与整体解码相同的 WHATWG 流式解码器语义。
 */
export class LineScanner {
  #startLine: number;
  #endLine: number;
  #position = 0;
  #newlines = 0;
  #lineStart = 0;
  #start?: number;
  #end?: number;
  #firstLineEnd?: number;
  #lastLineStart?: number;
  #selectedBytes = 0;
  #firstLineBytes = 0;
  #selection?: TextDecoder;
  #firstLine?: TextDecoder;
  /** 文件最初的字节，暂存到能判断是否为 BOM。 */
  #head: number[] | undefined = [];
  #bom = false;

  /** `startLine` 与 `endLine` 必须是非负整数且 `endLine > startLine`；缺省 `endLine` 表示到文件末尾。 */
  constructor(startLine: number, endLine: number = Number.POSITIVE_INFINITY) {
    if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
      throw new RangeError('Invalid line range');
    }
    if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine)) throw new RangeError('Invalid line range');
    this.#startLine = startLine;
    this.#endLine = endLine;
    if (startLine === 0) this.#begin(0);
  }

  push(chunk: Uint8Array): void {
    if (this.#head !== undefined) {
      const take = Math.min(3 - this.#head.length, chunk.length);
      this.#head.push(...chunk.subarray(0, take));
      if (this.#head.length < 3) return;
      this.#releaseHead();
      chunk = chunk.subarray(take);
    }
    this.#process(chunk);
  }

  #releaseHead(): void {
    const head = Uint8Array.from(this.#head ?? []);
    this.#head = undefined;
    this.#bom = startsWithBom(head);
    this.#process(head);
  }

  #process(chunk: Uint8Array): void {
    const base = this.#position;
    let from = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
      // 该换行结束第 this.#newlines 行；它只在选中行之间时才属于选区。
      this.#feed(chunk, base, from, index);
      const line = this.#newlines;
      const position = base + index;
      if (line === this.#startLine) this.#endFirstLine(position);
      if (line === this.#endLine - 1) this.#endSelection(position);
      this.#feed(chunk, base, index, index + 1);
      from = index + 1;
      this.#newlines++;
      this.#lineStart = position + 1;
      if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
      if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
    }
    this.#feed(chunk, base, from, chunk.length);
    this.#position += chunk.length;
  }

  finish(): LineScan {
    if (this.#head !== undefined) this.#releaseHead();
    const size = this.#position;
    if (this.#start === undefined) {
      return {
        newlines: this.#newlines,
        start: size,
        end: size,
        firstLineEnd: size,
        lastLineStart: size,
        selectedBytes: 0,
        firstLineBytes: 0,
      };
    }
    if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
    if (this.#end === undefined) this.#endSelection(size);
    return {
      newlines: this.#newlines,
      start: this.#start,
      end: this.#end ?? size,
      firstLineEnd: this.#firstLineEnd ?? size,
      // 超出最后一行的选区以最后一行收尾。
      lastLineStart: this.#lastLineStart ?? this.#lineStart,
      selectedBytes: this.#selectedBytes,
      firstLineBytes: this.#firstLineBytes,
    };
  }

  #begin(start: number): void {
    this.#start = start;
    if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
    this.#selection = rangeDecoder();
    this.#firstLine = rangeDecoder();
  }

  #endFirstLine(position: number): void {
    this.#firstLineEnd = position;
    if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
    this.#firstLine = undefined;
  }

  #endSelection(position: number): void {
    this.#end = position;
    if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
    this.#selection = undefined;
  }

  /** 把从文件偏移 `base` 开始的 `chunk[from, to)` 喂给仍处于打开状态的区间解码器。 */
  #feed(chunk: Uint8Array, base: number, from: number, to: number): void {
    // 整体解码会丢弃前导字节序标记。
    if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
    if (to <= from) return;
    const bytes = chunk.subarray(from, to);
    if (this.#selection !== undefined) {
      this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
    }
    if (this.#firstLine !== undefined) {
      this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
    }
  }
}

/** `BinaryReader.scanLines` 的返回结构。 */
export interface LineScan {
  /** 整个文件的换行符数；文件共 `newlines + 1` 行。 */
  newlines: number;
  /** 选中行的字节区间：从首行行首到末行行尾（不含末行的换行符）。 */
  start: number;
  end: number;
  /** 第一选中行的结束位置：其换行符或文件末尾。 */
  firstLineEnd: number;
  /** 最后选中行的起始位置。 */
  lastLineStart: number;
  /** 选区与其第一行解码后的 UTF-8 字节长度。 */
  selectedBytes: number;
  firstLineBytes: number;
}
