import type { FastifyInstance, FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import type { SseEvent } from '@matcheck/contracts';

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function publishEvent(_app: FastifyInstance, event: SseEvent): void {
  bus.emit('sse', event);
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/events',
    {
      preHandler: [app.authenticate],
    },
    async (req, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`:ok\n\n`);
      const listener = (evt: SseEvent) => {
        reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      };
      bus.on('sse', listener);
      const ping = setInterval(() => {
        reply.raw.write(
          `event: ping\ndata: {"type":"ping","ts":"${new Date().toISOString()}"}\n\n`,
        );
      }, 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        bus.off('sse', listener);
      });
      return reply;
    },
  );
}
