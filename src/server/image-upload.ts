import { setTimeout as delay } from 'node:timers/promises';
import { CallbackStyleFunction, LoggerLike, errorMessage, isRecord } from '../types';

const installedImageSender: CallbackStyleFunction = require('steamcommunity').prototype.sendImageToUser;
const results: Record<number, string> = require('steam-user/enums/EResult');
const transportCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH']);
export type ImageUploadPhase = 'prepare' | 'begin' | 'upload' | 'commit' | 'unknown';
type Community = { sendImageToUser?: CallbackStyleFunction; httpRequestPost?: CallbackStyleFunction; httpRequest?: CallbackStyleFunction };

function resultCode(error: unknown): number | undefined {
  if (isRecord(error) && Number.isInteger(Number(error.eresult)) && Number(error.eresult) > 0) return Number(error.eresult);
  // Steam's HTML error page can lose the structured EResult in the SDK.
  if (/^A server error occurred\. \(16\)\.?$/i.test(errorMessage(error).trim())) return 16;
  return undefined;
}

function transient(error: unknown): boolean {
  const result = resultCode(error);
  if (result !== undefined) return [3, 10, 16, 20, 79, 84].includes(result);
  if (!isRecord(error)) return false;
  return transportCodes.has(String(error.code || '').toUpperCase())
    || /^HTTP error 5\d\d$/.test(errorMessage(error));
}

function trackedAttempt(community: Community) {
  let phase: ImageUploadPhase = 'unknown';
  let httpStatus: number | undefined;
  // Only this installed SDK's known begin -> PUT -> commit implementation is
  // evidence that an error happened before delivery. Custom senders fail closed.
  if (community.sendImageToUser !== installedImageSender || typeof community.httpRequest !== 'function'
    || typeof community.httpRequestPost !== 'function') return { receiver: community, phase: () => phase, httpStatus: () => httpStatus };
  phase = 'prepare';
  const receiver: Community = Object.create(community);
  const wrap = (method: CallbackStyleFunction, nextPhase: (options: unknown) => ImageUploadPhase): CallbackStyleFunction => (...args) => {
    if (phase !== 'commit') phase = nextPhase(args[0]);
    const callback = args[1];
    if (typeof callback === 'function') args[1] = (...reply: unknown[]) => {
      const response = reply[1];
      httpStatus = isRecord(response) && typeof response.statusCode === 'number' ? response.statusCode : undefined;
      return callback(...reply);
    };
    // Delegate on the real instance so cookies, request IDs and session events
    // remain shared. Never replace methods on that instance during an upload.
    return method.apply(community, args);
  };
  receiver.httpRequestPost = wrap(community.httpRequestPost, options => {
    const uri = isRecord(options) ? String(options.uri || options.url || '') : '';
    if (uri === 'https://steamcommunity.com/chat/beginfileupload/?l=english') return 'begin';
    if (uri === 'https://steamcommunity.com/chat/commitfileupload/') return 'commit';
    return 'unknown';
  });
  receiver.httpRequest = wrap(community.httpRequest, options => isRecord(options) && options.method === 'PUT' ? 'upload' : 'unknown');
  return { receiver, phase: () => phase, httpStatus: () => httpStatus };
}

export async function sendSteamImage(
  community: Community,
  send: (receiver: Community) => Promise<unknown>,
  options: { authorize: () => void; logger: LoggerLike; wait?: (ms: number) => Promise<unknown> }
) {
  const started = Date.now();
  const wait = options.wait || delay;
  for (let attempt = 1; ; attempt++) {
    options.authorize();
    const tracked = trackedAttempt(community);
    try {
      return await send(tracked.receiver);
    } catch (error) {
      const phase = tracked.phase();
      const uncertain = phase === 'commit' || phase === 'unknown';
      const eresult = resultCode(error);
      const code = isRecord(error) && transportCodes.has(String(error.code)) ? String(error.code) : undefined;
      const retry = (phase === 'begin' || phase === 'upload') && transient(error) && attempt < 3;
      const diagnostics = { phase, eresult, result: eresult ? results[eresult] : undefined, code,
        httpStatus: tracked.httpStatus(), attempt, elapsedMs: Date.now() - started, uncertain, retry };
      // The production formatter omits metadata, so put only these allowlisted
      // fields in the message too. Never log upload URLs, cookies, HMAC or bodies.
      options.logger.warn?.(`Steam image upload failed ${JSON.stringify(diagnostics)}`, diagnostics);
      if (retry) { await wait(1000 * 2 ** (attempt - 1)); continue; }
      const message = eresult === 16
        ? uncertain ? `Steam ${phase === 'commit' ? '提交' : '处理'}图片超时（Timeout/16），结果未确认，请先检查聊天记录。`
          : `Steam ${phase === 'upload' ? '上传图片' : '准备图片上传'}超时（Timeout/16），${attempt > 1 ? '已自动重试 2 次，' : ''}请稍后重新发送。`
        : errorMessage(error);
      throw Object.assign(new Error(message), { statusCode: 502, imageUploadPhase: phase, uncertain,
        ...(eresult ? { eresult } : {}), ...(code ? { code } : {}) });
    }
  }
}
