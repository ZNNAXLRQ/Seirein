/**
 * Minimal OBS WebSocket v5 client (protocol reference: obs-websocket 5.x).
 *
 * Only what the assistant needs: connect, authenticate, and issue one request per call.
 * Connections are short-lived on purpose — OBS may restart, and a stale socket is worse
 * than a 30 ms reconnect.
 */
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const RPC_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;

/** obs-websocket auth: base64(sha256(base64(sha256(password + salt)) + challenge)). */
function buildAuth(password, salt, challenge) {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

export class ObsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ObsError';
    this.code = code;
  }
}

/**
 * Open a connection, authenticate if challenged, and return a request function.
 *
 * Every promise this module hands out settles. The connect promise fails with
 * `ObsHandshakeTimeout` when no Hello arrives in time, and with `ObsIdentifyTimeout` when Hello
 * arrives but the server never confirms `Identified`; a disconnect rejects every in-flight
 * request with one shared `ObsDisconnected` error (never a permanently pending promise); a
 * request that only runs out of its own deadline fails with `ObsTimeout`, so callers can tell
 * "slow" apart from "gone".
 *
 * @param {{host?: string, port?: number, password?: string, handshakeTimeoutMs?: number,
 *          requestTimeoutMs?: number, socketFactory?: (url: string) => WebSocket}} options
 *          `socketFactory` is a test seam; production always opens a real socket.
 * @returns {Promise<{request: (type: string, data?: object) => Promise<object>, close: () => void}>}
 */
export function connectObs(options = {}) {
  const {
    host = '127.0.0.1',
    port = 4455,
    password = '',
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    socketFactory = (url) => new WebSocket(url),
  } = options;

  return new Promise((resolve, reject) => {
    const socket = socketFactory(`ws://${host}:${port}`);
    const pending = new Map();
    let requestSeq = 0;
    let settled = false;
    /** The connection's terminal error; requests made after it reject with this same object. */
    let terminalError = null;
    let handshakeTimer = null;

    const clearHandshakeTimer = () => {
      if (handshakeTimer === null) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };

    /**
     * Arm the single active phase deadline. The handshake phase ends at Hello, but the
     * connection is only usable after Identified, so the same budget is re-armed as the
     * authentication deadline instead of being dropped.
     */
    const armDeadline = (error) => {
      if (settled || terminalError !== null) return;
      clearHandshakeTimer();
      handshakeTimer = setTimeout(() => {
        disconnect(error, { closeSocket: true });
      }, handshakeTimeoutMs);
      handshakeTimer.unref?.();
    };

    /** Reject every in-flight request with `error`, then clear: nothing is left pending. */
    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };

    /**
     * Tear the connection down and settle everything that depends on it. The first error wins
     * and is reused for every pending request (the same object), so a rejection always has one
     * identifiable cause.
     */
    const disconnect = (error, { closeSocket = false } = {}) => {
      if (terminalError === null) terminalError = error;
      clearHandshakeTimer();
      rejectPending(terminalError);
      if (!settled) {
        settled = true;
        reject(terminalError);
      }
      if (closeSocket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    };

    // No Hello within the deadline means no usable connection: fail it instead of waiting on ws.
    armDeadline(
      new ObsError(`OBS 握手超时：${handshakeTimeoutMs} ms 内未收到 Hello`, 'ObsHandshakeTimeout'),
    );

    const send = (type, data = {}) => {
      if (terminalError !== null) return Promise.reject(terminalError);
      const requestId = `req-${requestSeq++}`;
      const payload = { op: 6, d: { requestType: type, requestId, requestData: data } };
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rejectRequest(new ObsError(`OBS request timed out: ${type}`, 'ObsTimeout'));
        }, requestTimeoutMs);
        pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
        try {
          socket.send(JSON.stringify(payload));
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          rejectRequest(new ObsError(`OBS 发送失败: ${error?.message ?? error}`, 'ObsDisconnected'));
        }
      });
    };

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { op, d } = message;

      if (op === 0) {
        // Hello arrived: the handshake phase is over, but the connection is not usable until
        // Identified. Re-arm the same budget as the authentication deadline instead of
        // clearing the timer and leaving a server that never sends Identified pending forever.
        armDeadline(
          new ObsError(
            `OBS 认证超时：${handshakeTimeoutMs} ms 内未收到 Identified`,
            'ObsIdentifyTimeout',
          ),
        );
        // Hello: decide whether authentication is required.
        const auth = d?.authentication;
        const identify = { rpcVersion: RPC_VERSION };
        if (auth !== undefined) {
          if (password.length === 0) {
            disconnect(new ObsError('OBS 需要密码，但配置里没有 obsPassword', 'auth-required'), { closeSocket: true });
            return;
          }
          identify.authentication = buildAuth(password, auth.salt, auth.challenge);
        }
        socket.send(JSON.stringify({ op: 1, d: identify }));
        return;
      }

      if (op === 2) {
        // Identified
        if (!settled && terminalError === null) {
          settled = true;
          clearHandshakeTimer();
          resolve({
            request: send,
            close: () => {
              // Reject in-flight requests before dropping the socket; close() must not orphan them.
              disconnect(new ObsError('OBS 连接已关闭', 'ObsDisconnected'), { closeSocket: true });
            },
          });
        }
        return;
      }

      if (op === 7) {
        const entry = pending.get(d?.requestId);
        if (entry === undefined) return;
        pending.delete(d.requestId);
        clearTimeout(entry.timer);
        if (d.requestStatus?.result === true) entry.resolve(d.responseData ?? {});
        else entry.reject(new ObsError(d.requestStatus?.comment ?? 'OBS request failed', 'request-failed'));
      }
    });

    socket.on('error', (error) => {
      disconnect(new ObsError(`OBS 连接失败: ${error.message}`, 'ObsDisconnected'), { closeSocket: true });
    });
    socket.on('close', () => {
      disconnect(new ObsError('OBS 连接已关闭', 'ObsDisconnected'));
    });
  });
}
