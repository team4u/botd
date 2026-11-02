import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MessageAttachment, IncomingArtifactRef } from '@botd/protocol';
import type { HubStream } from './hub-stream.js';

/**
 * 回合输入的附件落盘：把 Hub 附件与上游产物下载到工作区 inbox/，
 * 视觉类图片转成模型输入，生成注入提示词的系统通知。
 */

const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface TurnImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface AttachmentIngestResult {
  /** 注入提示词的系统通知（无附件时为空串） */
  notice: string;
  /** 视觉模型可直接消费的图片输入 */
  images: TurnImage[];
}

export async function ingestTurnAttachments(
  workspaceDir: string,
  input: {
    attachments?: MessageAttachment[];
    incomingArtifacts?: IncomingArtifactRef[];
  },
  hubRpc: HubStream,
): Promise<AttachmentIngestResult> {
  const inboxDir = path.join(workspaceDir, 'inbox');
  const turnImages: TurnImage[] = [];
  const downloadedIds = new Set<string>();
  const attachmentLines: string[] = [];
  const incomingNotices: string[] = [];

  if (input.attachments?.length) {
    await fs.mkdir(inboxDir, { recursive: true });
    for (const att of input.attachments) {
      try {
        const downloaded = await hubRpc.downloadArtifact(att.id);
        downloadedIds.add(att.id);
        if (downloaded?.contentBase64) {
          const destPath = path.join(inboxDir, path.basename(att.filename));
          await fs.writeFile(destPath, Buffer.from(downloaded.contentBase64, 'base64'));
          const mime = (att.mimeType || downloaded.artifact?.mimeType || '').toLowerCase();
          if (VISION_MIME_TYPES.has(mime)) {
            turnImages.push({ type: 'image', data: downloaded.contentBase64, mimeType: mime });
          }
          attachmentLines.push(`inbox/${path.basename(att.filename)} (id: ${att.id}, ${att.mimeType}, ${att.sizeBytes} bytes)`);
        }
      } catch {
        // If an attachment isn't in artifacts table, don't crash the turn
      }
    }
  }

  if (input.incomingArtifacts?.length) {
    await fs.mkdir(inboxDir, { recursive: true });
    for (const art of input.incomingArtifacts) {
      if (downloadedIds.has(art.id)) continue;
      downloadedIds.add(art.id);
      try {
        const downloaded = await hubRpc.downloadArtifact(art.id);
        if (downloaded?.contentBase64) {
          const baseName = path.basename(art.filename || 'artifact');
          let actualFilename = baseName;
          if (existsSync(path.join(inboxDir, baseName))) {
            actualFilename = `${Date.now()}_${baseName}`;
          }
          const destPath = path.join(inboxDir, actualFilename);
          await fs.writeFile(destPath, Buffer.from(downloaded.contentBase64, 'base64'));
          const mime = (art.mimeType || downloaded.artifact?.mimeType || '').toLowerCase();
          if (VISION_MIME_TYPES.has(mime)) {
            turnImages.push({ type: 'image', data: downloaded.contentBase64, mimeType: mime });
          }
          incomingNotices.push(
            `[系统提示：来自上游任务的产物文件已自动同步至本机工作区 ./inbox/${actualFilename}，可直接读取处理]`,
          );
        }
      } catch {
        // If artifact download fails, don't crash the turn
      }
    }
  }

  let notice = '';
  if (attachmentLines.length > 0) {
    notice = `[本轮收到文件附件]\n已自动下载至工作区 inbox/ 目录：\n${attachmentLines.join('\n')}`;
  }
  if (incomingNotices.length > 0) {
    const block = incomingNotices.join('\n');
    notice = notice ? `${notice}\n\n${block}` : block;
  }
  return { notice, images: turnImages };
}

/** 判定模型是否接受图片输入（未知能力视为接受，与原实现一致） */
export function modelSupportsVision(model: unknown): boolean {
  return !Array.isArray((model as any).input) || (model as any).input.includes('image');
}

/** 头less 工具定义：剥离仅终端 UI 使用的可选渲染器 */
export function headlessTool(def: unknown): ToolDefinition {
  const { renderCall: _rc, renderResult: _rr, ...rest } = def as Record<string, unknown>;
  return rest as unknown as ToolDefinition;
}
