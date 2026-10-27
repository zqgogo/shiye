import { newId } from '@shiye/core';

/**
 * 跨上下文数据变更通知。
 *
 * 弹窗、service worker 与工作台标签页处在同一个扩展 origin，写的是同一个主库，
 * 但各自持有内存快照。这里用 BroadcastChannel 做一次「无内容」的变更广播：
 * 消息里只带发送者标识与时间，不携带任何收藏内容，避免把数据扩散到别的上下文。
 *
 * 频道不可用时静默降级——工作台仍会在窗口重新聚焦时刷新快照。
 */
const CHANNEL_NAME = 'shiye:data-changed';

const selfId = newId();

interface ChannelLike {
  postMessage(value: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

type ChannelCtor = new (name: string) => ChannelLike;

function openChannel(): ChannelLike | null {
  const ctor = (globalThis as { BroadcastChannel?: ChannelCtor }).BroadcastChannel;
  if (!ctor) return null;
  try {
    return new ctor(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** 在写入成功后调用：告诉同 origin 的其他上下文「主库变了」。 */
export function notifyDataChanged(): void {
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage({ from: selfId, at: Date.now() });
  } catch {
    // 广播失败不影响写入本身。
  } finally {
    channel.close();
  }
}

/** 订阅变更；返回取消订阅函数。自己发出的通知不会回调自己。 */
export function subscribeDataChanged(handler: () => void): () => void {
  const channel = openChannel();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { from?: unknown } | null;
    if (data && data.from === selfId) return;
    handler();
  };
  return () => {
    channel.onmessage = null;
    channel.close();
  };
}
