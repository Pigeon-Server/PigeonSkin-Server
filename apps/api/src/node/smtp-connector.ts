// Node 版 SMTP 连接器：用 net/tls 实现 smtp.ts 的 SmtpConnection 抽象。
//
// Workers 版基于 cloudflare:sockets（Socket.startTls），Node 版没有该
// API，但 net.Socket + tls.connect({ socket }) 提供同等的明文/STARTTLS/
// SSL 三种形态。smtpTransport.connect 是可注入接缝（smtp.ts 头注释），
// Node 入口在启动时整体替换。

import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { SmtpConnection, SmtpConnector } from '../services/smtp.ts';

function wrapSocket(socket: Socket | TLSSocket): SmtpConnection {
  let buffer: Buffer = Buffer.alloc(0);
  let ended = false;
  const waiting: Array<(value: Uint8Array | null) => void> = [];

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    flushWaiting();
  });
  socket.on('end', () => { ended = true; flushWaiting(); });
  socket.on('error', () => { ended = true; flushWaiting(); });

  function flushWaiting(): void {
    while (waiting.length) {
      const resolve = waiting.shift()!;
      if (buffer.length) {
        const chunk = buffer;
        buffer = Buffer.alloc(0);
        resolve(new Uint8Array(chunk));
      } else {
        resolve(null);
      }
    }
  }

  return {
    async read(): Promise<Uint8Array | null> {
      if (buffer.length) {
        const chunk = buffer;
        buffer = Buffer.alloc(0);
        return new Uint8Array(chunk);
      }
      if (ended) return null;
      return new Promise<Uint8Array | null>(resolve => waiting.push(resolve));
    },
    async write(chunk: Uint8Array): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.write(chunk, error => (error ? reject(error) : resolve()));
      });
    },
    startTls(): SmtpConnection {
      // STARTTLS 升级在现有明文流上进行；tls.connect({ socket }) 接管
      // 同一 socket（Workers 版同样要求先释放读端——这里读端是事件驱动
      // 的，没有持有的 reader 可释放，直接升级即可）
      return wrapSocket(tlsConnect({ socket }));
    },
    async close(): Promise<void> {
      await new Promise<void>(resolve => {
        socket.end(() => resolve());
      });
    },
  };
}

/** Node 版连接器；Node 入口启动时赋给 smtpTransport.connect */
export const nodeSmtpConnector: SmtpConnector = async (host, port, encryption) => {
  const socket = encryption === 'ssl'
    ? tlsConnect({ host, port, servername: host })
    : tcpConnect({ host, port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onReady = () => { cleanup(); resolve(); };
    const cleanup = () => {
      socket.off('error', onError);
      socket.off(encryption === 'ssl' ? 'secureConnect' : 'connect', onReady);
    };
    socket.once('error', onError);
    socket.once(encryption === 'ssl' ? 'secureConnect' : 'connect', onReady);
  });
  return wrapSocket(socket);
};
