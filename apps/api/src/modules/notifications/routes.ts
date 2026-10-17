import { Router } from 'express';
import {
  CreateNotificationInput,
  ID_PREFIX,
  IDEMPOTENCY_KEY_MAX,
  ListNotificationsQuery,
  PageQuery,
} from '@alertly/shared';
import { parse } from '../../middleware/validate';
import { userIdOf, type AuthMiddleware } from '../../middleware/auth';
import { validationError } from '../../lib/errors';
import { decodeId } from '../../lib/ids';
import type { NotificationsService } from './service';

const VALID_KEY = /^[\x21-\x7e]+$/; // printable ASCII, no spaces

export function notificationRoutes(
  notifications: NotificationsService,
  mw: AuthMiddleware,
): Router {
  const r = Router();
  r.use('/notifications', mw.requireSessionOrApiKey);

  /**
   * 201 Created on first sight of a request.
   * 200 + `Idempotent-Replayed: true` when the same Idempotency-Key + body is sent again
   *   (e.g. the client timed out and retried): the original notification, nothing new created.
   * 409 when the key is reused with a different body.
   */
  r.post('/notifications', async (req, res) => {
    const key = req.get('idempotency-key');
    if (key !== undefined && (key.length > IDEMPOTENCY_KEY_MAX || !VALID_KEY.test(key))) {
      throw validationError(`Idempotency-Key: up to ${IDEMPOTENCY_KEY_MAX} printable characters`);
    }
    const input = parse(CreateNotificationInput, req.body);
    const result = await notifications.create(
      userIdOf(req),
      {
        title: input.title,
        body: input.body,
        data: input.data,
        priority: input.priority,
        channelIds: input.channelIds?.map((id) => decodeId(ID_PREFIX.channel, id, 'Channel')),
      },
      { source: 'api', idempotencyKey: key },
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.replayed ? 200 : 201).json(result.notification);
  });

  r.get('/notifications', async (req, res) => {
    const page = parse(PageQuery, req.query);
    const f = parse(ListNotificationsQuery, req.query);
    res.json(
      await notifications.list(
        userIdOf(req),
        {
          source: f.source,
          from: f.from ? new Date(f.from) : undefined,
          to: f.to ? new Date(f.to) : undefined,
        },
        page.limit,
        page.cursor,
      ),
    );
  });

  r.get('/notifications/:id', async (req, res) => {
    const id = decodeId(ID_PREFIX.notification, req.params.id, 'Notification');
    res.json(await notifications.getWithTimeline(userIdOf(req), id));
  });

  return r;
}
