import { createHash, randomBytes } from 'node:crypto';
import { HistoryItem, errorMessage, isRecord } from '../types';
import type { ImageUploadPhase } from './image-upload';

export type SendOwner = { userId: number; sessionId: string; account: string };
export type SendState = 'prepared' | 'queued' | 'sending' | 'retry_wait' | 'waiting_connection' | 'failed' | 'unknown' | 'sent' | 'cancelled';
export type SendOperationView = {
  id: string; peerId: string; name: string; steamAccountId: string; state: SendState; version: number;
  phase: ImageUploadPhase; attempts: number; totalAttempts: number; maxAttempts: number; nextRetryAt: number;
  deadline: number; createdAt: number; expiresAt: number; error?: string; retryable: boolean; hasImage: boolean;
  item?: HistoryItem;
  cooldownUntil: number;
  previousOperationId?: string; replacementId?: string;
  batchId?: string; batchIndex?: number; batchSize?: number; waitingForOperationId?: string;
};
type Batch = { id: string; members: Operation[]; size: number; expiresAt: number; expired: boolean; finished: boolean };
type Operation = {
  id: string; owner: SendOwner; peerId: string; name: string; state: SendState; version: number;
  phase: ImageUploadPhase; attempts: number; totalAttempts: number; nextRetryAt: number; deadline: number;
  createdAt: number; expiresAt: number; error?: string; retryable: boolean; item?: HistoryItem;
  buffer?: Buffer; digest?: string; running: boolean; refreshed: boolean; stopped: boolean;
  controller?: AbortController; authorize: () => boolean;
  previousOperationId?: string; replacementId?: string;
  transports: number; releaseRequested: boolean;
  batch?: Batch; batchIndex?: number; waitingForOperationId?: string;
};
export type SendOperationOptions = {
  send: (op: { operationId: string; attempt: number; totalAttempts: number; account: string; peerId: string; buffer: Buffer; deadline: number; signal: AbortSignal;
    authorize: () => void; phase: (phase: ImageUploadPhase) => void; transport: (pending: Promise<unknown>) => void }) => Promise<HistoryItem>;
  refreshWebSession: () => Promise<unknown>;
  onChange?: (owner: SendOwner, operation: SendOperationView) => void;
  // Timing and limits are injectable for deterministic local verification.
  tickMs?: number; windowMs?: number; delaysMs?: number[]; maxAttempts?: number; random?: () => number;
  preparedMs?: number; imageMs?: number; resultMs?: number; maxBytes?: number; userBytes?: number; maxTasks?: number;
  batchMs?: number;
};
const fault = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const active = (state: SendState) => ['queued', 'sending', 'retry_wait', 'waiting_connection'].includes(state);

export class SendOperations {
  readonly instanceId = randomBytes(16).toString('hex');
  private operations = new Map<string, Operation>();
  private batches = new Set<Batch>();
  private cooldowns = new Map<string, number>();
  private tasks = new Set<Promise<void>>();
  private transports = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly maxAttempts: number;
  constructor(private options: SendOperationOptions) {
    this.maxAttempts = options.maxAttempts ?? 6;
    this.timer = setInterval(() => this.pump(), options.tickMs ?? 500);
    this.timer.unref?.();
  }
  private touch(op: Operation) {
    op.waitingForOperationId = this.blocker(op)?.id;
    this.emit(op);
    // Only changed dependency hints are emitted; never recursively touch a batch.
    for (const member of op.batch?.members ?? []) {
      if (member === op) continue;
      const waiting = this.blocker(member)?.id;
      if (member.waitingForOperationId !== waiting) {
        member.waitingForOperationId = waiting; this.emit(member);
      }
    }
  }
  private emit(op: Operation) {
    op.version++;
    try { this.options.onChange?.(op.owner, this.view(op)); } catch { /* A dropped UI hint cannot affect sending. */ }
  }
  private blocker(op: Operation): Operation | undefined {
    if (!op.batch || op.batch.expired || op.batch.finished || (!active(op.state) && op.state !== 'prepared' && op.state !== 'failed')) return;
    return op.batch.members.slice(0, op.batchIndex).find(previous => this.operations.get(previous.id) !== previous
      || !(previous.state === 'sent' || (previous.state === 'cancelled' && !previous.running && !previous.transports)));
  }
  cooldownUntil(account: string): number {
    const until = this.cooldowns.get(account) || 0;
    if (until <= Date.now()) { this.cooldowns.delete(account); return 0; }
    return until;
  }
  rateLimited(account: string, retryAfterMs = 30000): number {
    const delay = Number.isFinite(retryAfterMs) ? Math.max(30000, Math.ceil(retryAfterMs)) : 30000;
    const candidate = Date.now() + delay;
    const until = Math.max(this.cooldownUntil(account), Number.isSafeInteger(candidate) ? candidate : Date.now() + 30000);
    this.cooldowns.set(account, until);
    return until;
  }
  private view(op: Operation): SendOperationView {
    return { id: op.id, peerId: op.peerId, name: op.name, steamAccountId: op.owner.account, state: op.state,
      version: op.version, phase: op.phase, attempts: op.attempts, totalAttempts: op.totalAttempts,
      maxAttempts: this.maxAttempts, nextRetryAt: op.nextRetryAt, deadline: op.deadline, createdAt: op.createdAt,
      expiresAt: op.expiresAt, error: op.error, retryable: op.retryable && !op.transports && Boolean(op.buffer), hasImage: !op.releaseRequested && Boolean(op.buffer), item: op.item,
      cooldownUntil: this.cooldowns.get(op.owner.account) || 0, previousOperationId: op.previousOperationId, replacementId: op.replacementId,
      batchId: op.batch?.id, batchIndex: op.batchIndex, batchSize: op.batch?.size, waitingForOperationId: op.waitingForOperationId };
  }
  private find(id: string, owner: SendOwner): Operation {
    const op = this.operations.get(id);
    if (!op) throw fault('原发送状态已失效，请检查聊天记录。', 410);
    if (op.owner.userId !== owner.userId || op.owner.sessionId !== owner.sessionId || op.owner.account !== owner.account) {
      throw fault('没有权限访问这条发送任务。', 403);
    }
    return op;
  }
  prepare(owner: SendOwner, peerId: string, name: string, authorize: () => boolean, previousOperationId?: string, clientOperationId?: string) {
    if (clientOperationId !== undefined && (typeof clientOperationId !== 'string' || !/^[a-f0-9]{32}$/.test(clientOperationId))) {
      throw fault('Invalid operation ID', 400);
    }
    if (previousOperationId !== undefined && (typeof previousOperationId !== 'string' || !/^[a-f0-9]{32}$/.test(previousOperationId))) {
      throw fault('Invalid previous operation', 400);
    }
    this.cleanup();
    // Resolve an existing ID before checking the parent: its late acknowledgement may
    // have changed unknown to sent, or its retained result may already have expired.
    if (clientOperationId && this.operations.has(clientOperationId)) {
      const existing = this.find(clientOperationId, owner);
      if (existing.batch) throw fault('批次成员只能通过原任务启动。');
      if (existing.peerId !== peerId || existing.previousOperationId !== previousOperationId || existing.name !== name.slice(0, 240)) {
        throw fault('同一发送任务不能更换联系人、名称或原任务关联。');
      }
      return this.view(existing);
    }
    const previous = previousOperationId ? this.find(previousOperationId, owner) : undefined;
    if (previous && (previous.state !== 'unknown' || previous.peerId !== peerId)) throw fault('只能为原联系人重新发送未知任务。');
    if (previous?.replacementId) {
      if (clientOperationId && previous.replacementId !== clientOperationId) throw fault('原任务已有替换任务，请查询发送结果。');
      const replacement = this.find(previous.replacementId, owner);
      if (replacement.peerId !== peerId || replacement.previousOperationId !== previous.id) throw fault('原任务的替换关联已失效，请检查聊天记录。');
      return this.view(replacement);
    }
    this.checkCapacity(owner, 1);
    const op = this.createOperation(owner, peerId, name, authorize, previousOperationId, clientOperationId);
    this.operations.set(op.id, op);
    if (previous) { previous.replacementId = op.id; this.touch(previous); }
    return this.view(op);
  }
  private checkCapacity(owner: SendOwner, count: number) {
    if (this.closed) throw fault('服务正在停止。', 503);
    if (this.operations.size + count > (this.options.maxTasks ?? 1000)
      || [...this.operations.values()].filter(op => op.owner.userId === owner.userId && (active(op.state) || op.state === 'prepared')).length + count > 10) {
      throw fault('待发送任务已满，请稍后重试。', 429);
    }
  }
  prepareBatch(owner: SendOwner, peerId: string, names: string[], authorize: () => boolean, instanceId: string) {
    if (instanceId !== this.instanceId) throw fault('发送服务已重启，请刷新后重新选择图片。');
    if (!Array.isArray(names) || names.length < 1 || names.length > 10 || Array.from(names).some(name => typeof name !== 'string')) {
      throw fault('names must contain 1 to 10 image names', 400);
    }
    this.cleanup(); this.checkCapacity(owner, names.length);
    const batch: Batch = { id: randomBytes(16).toString('hex'), members: [], size: names.length,
      expiresAt: Date.now() + (this.options.batchMs ?? 30 * 60 * 1000), expired: false, finished: false };
    // Build every member before publishing any: validation and quota failures cannot create a prefix.
    batch.members = names.map((name, batchIndex) => ({ ...this.createOperation(owner, peerId, name, authorize),
      batch, batchIndex, expiresAt: batch.expiresAt }));
    for (const op of batch.members) this.operations.set(op.id, op);
    this.batches.add(batch);
    for (const op of batch.members) op.waitingForOperationId = this.blocker(op)?.id;
    return { batchId: batch.id, operations: batch.members.map(op => this.view(op)) };
  }
  private createOperation(owner: SendOwner, peerId: string, name: string, authorize: () => boolean,
    previousOperationId?: string, clientOperationId?: string): Operation {
    const now = Date.now();
    return { id: clientOperationId ?? randomBytes(16).toString('hex'), owner: { ...owner }, peerId, name: name.slice(0, 240),
      state: 'prepared', version: 1, phase: 'prepare', attempts: 0, totalAttempts: 0, nextRetryAt: 0, deadline: 0,
      createdAt: now, expiresAt: now + (this.options.preparedMs ?? 300000), retryable: false,
      running: false, refreshed: false, stopped: false, authorize, previousOperationId, transports: 0, releaseRequested: false };
  }
  get(id: string, owner: SendOwner) { this.cleanup(); return this.view(this.find(id, owner)); }
  image(id: string, owner: SendOwner) {
    this.cleanup(); const op = this.find(id, owner);
    if (!op.buffer || op.releaseRequested) throw fault('原图已过期，请重新选择图片。', 410);
    return op.buffer;
  }
  async loadAndStart(id: string, owner: SendOwner, load: () => Promise<Buffer>) {
    this.cleanup(); const op = this.find(id, owner);
    const buffer = await load();
    // A client ID can be reused after retention expires. A late image load must
    // never activate a different operation that has since acquired that ID.
    this.cleanup();
    if (this.operations.get(id) !== op) throw fault('原发送状态已失效，请检查聊天记录。', 410);
    return this.start(id, owner, buffer);
  }
  start(id: string, owner: SendOwner, buffer: Buffer) {
    this.cleanup(); const op = this.find(id, owner);
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (op.digest) {
      if (op.digest !== digest) throw fault('同一发送任务不能更换图片。');
      return this.view(op);
    }
    if (op.state !== 'prepared' || this.closed) throw fault('这条任务不能开始发送。');
    if (!buffer.length || buffer.length > 7 * 1024 * 1024) throw fault('图片必须小于 7 MiB 且不能为空。', 413);
    const all = [...this.operations.values()];
    const bytes = all.reduce((sum, item) => sum + (item.buffer?.length || 0), 0);
    const userBytes = all.filter(item => item.owner.userId === owner.userId).reduce((sum, item) => sum + (item.buffer?.length || 0), 0);
    if (bytes + buffer.length > (this.options.maxBytes ?? 128 * 1024 * 1024)
      || userBytes + buffer.length > (this.options.userBytes ?? 32 * 1024 * 1024)) throw fault('待发送图片占用已达上限，请稍后重试。', 429);
    op.buffer = Buffer.from(buffer); op.digest = digest;
    this.newRound(op);
    return this.view(op);
  }
  private newRound(op: Operation) {
    op.state = 'queued'; op.attempts = 0; op.refreshed = false; op.stopped = false; op.retryable = false;
    op.error = undefined; op.nextRetryAt = 0; op.deadline = op.batch ? 0 : Date.now() + (this.options.windowMs ?? 120000);
    op.expiresAt = op.batch?.expiresAt ?? op.deadline + (this.options.imageMs ?? 900000); this.touch(op);
  }
  retry(id: string, owner: SendOwner, expectedVersion: number) {
    this.cleanup(); const op = this.find(id, owner);
    if (active(op.state)) return this.view(op);
    if (op.version !== expectedVersion) throw fault('发送状态已改变，请刷新发送结果。');
    if (op.running || op.transports || op.state !== 'failed' || !op.retryable || !op.buffer) throw fault('不能重试这条任务，请先检查发送结果。');
    this.newRound(op); return this.view(op);
  }
  expedite(id: string, owner: SendOwner, expectedVersion: number) {
    this.cleanup();
    const op = this.find(id, owner);
    if (op.version !== expectedVersion) throw fault('发送状态已改变，请刷新发送结果。');
    if (op.state !== 'retry_wait' || op.running) return this.view(op);
    if ((this.cooldowns.get(op.owner.account) || 0) > Date.now()) throw fault('Steam 限流冷却中，请等待倒计时结束。', 429);
    op.nextRetryAt = 0; op.state = 'queued'; this.touch(op); return this.view(op);
  }
  cancel(id: string, owner: SendOwner) {
    this.cleanup();
    return this.cancelOperation(this.find(id, owner));
  }
  private cancelOperation(op: Operation) {
    if (op.batch?.expired) return this.view(op);
    if (op.state === 'sent' || op.state === 'cancelled') return this.view(op);
    op.stopped = true; op.retryable = false; op.nextRetryAt = 0;
    if (op.state === 'unknown' || (op.running && (op.phase === 'commit' || op.phase === 'unknown'))) {
      op.state = 'unknown'; op.error = '已停止等待，发送结果未确认，请检查聊天记录。';
    } else {
      op.state = 'cancelled'; op.error = '已停止重试。'; op.controller?.abort(); this.release(op);
    }
    this.touch(op); return this.view(op);
  }
  private release(op: Operation) {
    op.releaseRequested = true;
    if (!op.transports) op.buffer = undefined;
    op.expiresAt = Date.now() + (this.options.resultMs ?? 3600000);
  }
  private cleanup() {
    const now = Date.now();
    for (const batch of this.batches) {
      if (now >= batch.expiresAt) this.expireBatch(batch);
      const finished = batch.expired || batch.members.every(op => !op.running && !op.transports
        && (op.state === 'sent' || op.state === 'cancelled' || (op.state === 'failed' && !op.retryable)));
      if (finished) {
        batch.finished = true; this.batches.delete(batch);
        for (const op of batch.members) this.touch(op);
        batch.members = []; // Results may remain queryable, but no longer pin the whole batch.
      }
    }
    for (const [id, op] of this.operations) {
      if (op.running || op.transports || active(op.state) || op.expiresAt > now) continue;
      if (op.buffer) { this.release(op); op.retryable = false; op.error = '原图已过期，请重新选择图片。'; this.touch(op); }
      else if (!op.batch || op.batch.finished) this.operations.delete(id);
    }
    for (const [id, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(id);
  }
  private expireBatch(batch: Batch) {
    if (batch.expired || batch.finished) return;
    batch.expired = true;
    for (const op of batch.members) {
      op.stopped = true; op.retryable = false; op.nextRetryAt = 0;
      if (op.state !== 'sent' && op.state !== 'cancelled') {
        op.state = op.state === 'unknown' || (op.running && (op.phase === 'commit' || op.phase === 'unknown')) ? 'unknown' : 'failed';
        op.error = op.state === 'unknown' ? '批次已过期，发送结果未确认，请检查聊天记录。' : '发送批次已过期，请重新选择图片。';
      }
      if (op.state !== 'unknown') op.controller?.abort();
      this.release(op); this.touch(op);
    }
  }
  private fail(op: Operation, message: string, retryable: boolean) {
    op.state = 'failed'; op.retryable = retryable; op.error = message; op.nextRetryAt = 0;
    op.expiresAt = Date.now() + (this.options.imageMs ?? 900000);
    if (!retryable) this.release(op);
    this.touch(op);
  }
  private pump() {
    this.cleanup(); if (this.closed) return;
    const now = Date.now();
    for (const op of this.operations.values()) {
      if (!active(op.state)) continue;
      if (op.running) {
        if (now >= op.deadline) {
          if (op.phase === 'commit' || op.phase === 'unknown') {
            op.state = 'unknown'; op.stopped = true; op.error = '发送结果未确认，请检查聊天记录。'; this.touch(op);
          } else op.controller?.abort(Object.assign(fault('自动重试等待已超时，请稍后重试。'), { retryable: true }));
        }
        continue;
      }
      if (op.batch?.expired || this.blocker(op)) continue;
      if (!op.deadline) {
        op.deadline = now + (this.options.windowMs ?? 120000);
        op.expiresAt = op.deadline + (this.options.imageMs ?? 900000); this.touch(op);
      }
      if (now >= op.deadline || op.attempts >= this.maxAttempts) { this.fail(op, op.error || '自动重试已结束，请稍后重试。', true); continue; }
      let online: boolean;
      try { online = op.authorize(); } catch (error) { this.fail(op, errorMessage(error), false); continue; }
      if (!online) {
        if (op.state !== 'waiting_connection') { op.state = 'waiting_connection'; op.error = '等待 Steam 恢复连接…'; this.touch(op); }
        continue;
      }
      const cooldown = this.cooldowns.get(op.owner.account) || 0;
      if (cooldown > now && op.nextRetryAt < cooldown) {
        op.state = 'retry_wait'; op.nextRetryAt = cooldown; op.error = 'Steam 发送频率受限，正在等待冷却。'; this.touch(op);
      }
      if (op.nextRetryAt > now || op.transports) continue;
      if ([...this.operations.values()].filter(item => item.owner.account === op.owner.account && (item.running || item.transports)).length >= 2) continue;
      op.running = true; op.state = 'sending'; op.phase = 'prepare'; op.error = undefined;
      op.attempts++; op.totalAttempts++; op.controller = new AbortController(); this.touch(op);
      const task = this.run(op); this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
  }
  private async run(op: Operation) {
    try {
      const item = await this.options.send({ operationId: op.id, attempt: op.attempts, totalAttempts: op.totalAttempts,
        account: op.owner.account, peerId: op.peerId, buffer: op.buffer!,
        signal: op.controller!.signal, deadline: op.deadline,
        authorize: () => {
          if (op.batch && Date.now() >= op.batch.expiresAt) this.expireBatch(op.batch);
          if (this.closed || op.stopped) throw fault('发送已停止。');
          if (op.controller!.signal.aborted) throw op.controller!.signal.reason;
          if (Date.now() >= op.deadline) throw Object.assign(fault('自动重试等待已超时，请稍后重试。'), { retryable: true });
          if (!op.authorize()) throw Object.assign(fault('Steam 暂时离线。', 503), { retryable: true });
        },
        phase: phase => { op.phase = phase; this.touch(op); },
        transport: pending => {
          op.transports++; this.transports.add(pending);
          void pending.finally(() => {
            op.transports--; this.transports.delete(pending);
            if (op.releaseRequested && !op.transports) op.buffer = undefined;
            this.touch(op);
          }).catch(() => {});
        }
      });
      if (op.batch && Date.now() >= op.batch.expiresAt) this.expireBatch(op.batch);
      if (op.state === 'cancelled' || (op.batch?.expired && op.state === 'failed')) return;
      op.item = item; op.state = 'sent'; op.retryable = false; op.error = undefined; this.release(op); this.touch(op);
    } catch (error) {
      if (op.batch && Date.now() >= op.batch.expiresAt) this.expireBatch(op.batch);
      if (op.batch?.expired) return;
      if (op.state === 'cancelled') return;
      const retryAfter = isRecord(error) && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 30000;
      if (isRecord(error) && Number(error.eresult) === 84) {
        this.rateLimited(op.owner.account, retryAfter);
      }
      const uncertain = isRecord(error) && typeof error.uncertain === 'boolean' ? error.uncertain : op.phase === 'commit' || op.phase === 'unknown';
      if (uncertain) {
        op.state = 'unknown'; op.error = errorMessage(error); op.retryable = false;
        op.expiresAt = Date.now() + (this.options.imageMs ?? 900000); this.touch(op); return;
      }
      if (this.closed || op.stopped) { op.state = 'cancelled'; this.release(op); this.touch(op); return; }
      const login = isRecord(error) && Number(error.eresult) === 21 && !op.refreshed;
      let retryable = isRecord(error) && error.retryable === true;
      if (login) {
        op.refreshed = true;
        try {
          await this.refresh(op); retryable = true;
        } catch (refreshError) {
          if (op.stopped || this.closed) return;
          this.fail(op, errorMessage(refreshError), true); return;
        }
      }
      if (op.stopped || this.closed) { op.state = 'cancelled'; this.release(op); this.touch(op); return; }
      if (!retryable || op.attempts >= this.maxAttempts || Date.now() >= op.deadline) { this.fail(op, errorMessage(error), retryable); return; }
      const delays = this.options.delaysMs || [2000, 4000, 8000, 16000, 30000];
      let wait = delays[Math.min(op.attempts - 1, delays.length - 1)] * (0.8 + 0.4 * (this.options.random || Math.random)());
      if (isRecord(error) && Number(error.eresult) === 84) {
        wait = Math.max(wait, retryAfter);
        this.cooldowns.set(op.owner.account, Math.max(this.cooldowns.get(op.owner.account) || 0, Date.now() + wait));
      }
      op.state = 'retry_wait'; op.error = errorMessage(error); op.retryable = true;
      op.nextRetryAt = Date.now() + wait; this.touch(op);
    } finally { op.running = false; op.controller = undefined; this.touch(op); }
  }
  private async refresh(op: Operation) {
    const signal = op.controller!.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: () => void = () => {};
    try {
      await Promise.race([this.options.refreshWebSession(), new Promise<never>((_resolve, reject) => {
        stop = () => reject(fault('网页登录刷新已停止。'));
        signal.addEventListener('abort', stop, { once: true });
        timer = setTimeout(() => reject(fault('网页登录刷新超时，请稍后重试。')), Math.max(1, op.deadline - Date.now()));
        if (signal.aborted) stop();
      })]);
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    this.cleanup();
    for (const op of this.operations.values()) this.cancelOperation(op);
    await Promise.allSettled([...this.tasks]); await Promise.allSettled([...this.transports]); this.operations.clear(); this.batches.clear();
  }
}
