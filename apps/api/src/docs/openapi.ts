import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as S from '@alertly/shared';

/**
 * The OpenAPI 3.1 document, generated from the SAME Zod schemas the API validates with
 * (packages/shared). The docs can't drift from the real validation rules.
 * Served at /docs (Swagger UI) and /docs/openapi.json.
 */
export function buildOpenApiDocument(serverUrl = '/') {
  const r = new OpenAPIRegistry();

  r.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'alertly_session',
    description: 'Dashboard session (set by /auth/login).',
  });
  r.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key: `Authorization: Bearer alr_…`. Create one in the dashboard.',
  });

  const json = (schema: z.ZodType, description = 'OK') => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: S.Problem } },
  });
  const errors = {
    401: problem('Not authenticated'),
    404: problem('Not found (also returned for resources owned by someone else)'),
    422: problem('Validation failed'),
    429: problem('Rate limited or quota reached; see Retry-After'),
  };
  type Security = Record<string, string[]>[];
  const SESSION: Security = [{ session: [] }];
  const EITHER: Security = [{ session: [] }, { apiKey: [] }];
  const idParam = (prefix: string) =>
    z.object({ id: S.publicId(prefix).meta({ example: `${prefix}_1F` }) });

  type Method = 'get' | 'post' | 'patch' | 'delete';
  function route(
    method: Method,
    path: string,
    tag: string,
    summary: string,
    o: {
      security?: Security;
      params?: z.ZodObject;
      query?: z.ZodObject;
      headers?: z.ZodObject;
      body?: z.ZodType;
      responses: Record<
        number,
        ReturnType<typeof json> | ReturnType<typeof problem> | { description: string }
      >;
    },
  ) {
    r.registerPath({
      method,
      path: `/api/v1${path}`,
      tags: [tag],
      summary,
      security: o.security,
      request: {
        params: o.params,
        query: o.query,
        headers: o.headers,
        body: o.body ? { content: { 'application/json': { schema: o.body } } } : undefined,
      },
      responses: o.responses,
    });
  }

  // ---- Auth
  route('post', '/auth/register', 'Auth', 'Create an account (sets the session cookie)', {
    body: S.RegisterInput,
    responses: {
      201: json(S.UserResponse, 'Created'),
      409: problem('Email already registered'),
      422: errors[422],
    },
  });
  route('post', '/auth/login', 'Auth', 'Log in (sets the session cookie)', {
    body: S.LoginInput,
    responses: {
      200: json(S.UserResponse),
      401: problem('Invalid email or password'),
      429: errors[429],
    },
  });
  route('post', '/auth/logout', 'Auth', 'Log out (clears the cookie)', {
    responses: { 204: { description: 'Logged out' } },
  });
  route('get', '/auth/me', 'Auth', 'Current user', {
    security: SESSION,
    responses: { 200: json(S.UserResponse), 401: errors[401] },
  });

  // ---- API keys
  route('get', '/api-keys', 'API keys', 'List API keys', {
    security: SESSION,
    responses: { 200: json(z.object({ data: z.array(S.ApiKey) })) },
  });
  route('post', '/api-keys', 'API keys', 'Create an API key (the full key is returned only here)', {
    security: SESSION,
    body: S.CreateApiKeyInput,
    responses: { 201: json(S.ApiKeyCreated, 'Created'), 409: problem('Too many active keys') },
  });
  route('delete', '/api-keys/{id}', 'API keys', 'Revoke an API key', {
    security: SESSION,
    params: idParam('key'),
    responses: { 204: { description: 'Revoked' }, 404: errors[404] },
  });

  // ---- Channels
  route('get', '/channels', 'Channels', 'List channels', {
    security: EITHER,
    responses: { 200: json(z.object({ data: z.array(S.Channel) })) },
  });
  route(
    'post',
    '/channels',
    'Channels',
    'Create a channel (webhooks get a signing secret, shown once)',
    {
      security: SESSION,
      body: S.CreateChannelInput,
      responses: { 201: json(S.ChannelWithSecret, 'Created'), 422: errors[422] },
    },
  );
  route('get', '/channels/{id}', 'Channels', 'Get a channel', {
    security: EITHER,
    params: idParam('ch'),
    responses: { 200: json(S.Channel), 404: errors[404] },
  });
  route('patch', '/channels/{id}', 'Channels', 'Rename, change config, enable or disable', {
    security: SESSION,
    params: idParam('ch'),
    body: S.UpdateChannelInput,
    responses: { 200: json(S.Channel), 404: errors[404], 422: errors[422] },
  });
  route('delete', '/channels/{id}', 'Channels', 'Delete a channel', {
    security: SESSION,
    params: idParam('ch'),
    responses: { 204: { description: 'Deleted' }, 409: problem('Used by an active alert rule') },
  });
  route('post', '/channels/{id}/test', 'Channels', 'Send a test notification to this channel', {
    security: SESSION,
    params: idParam('ch'),
    responses: { 202: json(S.ChannelTestResult, 'Queued; poll the notification for its delivery') },
  });
  route('post', '/channels/{id}/rotate-secret', 'Channels', 'Rotate a webhook signing secret', {
    security: SESSION,
    params: idParam('ch'),
    responses: { 200: json(S.ChannelWithSecret) },
  });

  // ---- Notifications
  route('post', '/notifications', 'Notifications', 'Send a notification', {
    security: EITHER,
    headers: z.object({
      'Idempotency-Key': z.string().max(S.IDEMPOTENCY_KEY_MAX).optional().meta({
        description: 'Recommended. Retrying with the same key never creates a duplicate.',
      }),
    }),
    body: S.CreateNotificationInput,
    responses: {
      201: json(S.Notification, 'Created; deliveries are queued'),
      200: json(
        S.Notification,
        'Replay of an earlier request with the same Idempotency-Key (header Idempotent-Replayed: true)',
      ),
      409: problem('Idempotency-Key reused with a different body'),
      ...errors,
    },
  });
  route('get', '/notifications', 'Notifications', 'List notifications (newest first)', {
    security: EITHER,
    query: S.PageQuery.extend(S.ListNotificationsQuery.shape),
    responses: { 200: json(S.pageOf(S.Notification)) },
  });
  route('get', '/notifications/{id}', 'Notifications', 'Notification with its delivery timeline', {
    security: EITHER,
    params: idParam('ntf'),
    responses: { 200: json(S.NotificationDetail), 404: errors[404] },
  });

  // ---- Deliveries
  route('get', '/deliveries', 'Deliveries', 'Delivery log (newest first)', {
    security: EITHER,
    query: S.PageQuery.extend(S.ListDeliveriesQuery.shape),
    responses: { 200: json(S.pageOf(S.Delivery)) },
  });
  route('get', '/deliveries/stats', 'Deliveries', 'Counts per status and success rate', {
    security: EITHER,
    query: z.object({ hours: z.number().int().min(1).max(720).optional() }),
    responses: { 200: json(S.DeliveryStats) },
  });
  route('get', '/deliveries/{id}', 'Deliveries', 'A delivery with all its attempts', {
    security: EITHER,
    params: idParam('dlv'),
    responses: { 200: json(S.DeliveryWithAttempts), 404: errors[404] },
  });
  route('post', '/deliveries/{id}/retry', 'Deliveries', 'Retry a failed or dead delivery', {
    security: SESSION,
    params: idParam('dlv'),
    responses: { 200: json(S.DeliveryWithAttempts), 409: problem('Not failed or dead') },
  });

  // ---- Alerts
  route('get', '/alerts', 'Alerts', 'List alert rules', {
    security: SESSION,
    responses: { 200: json(z.object({ data: z.array(S.AlertRule) })) },
  });
  route('post', '/alerts', 'Alerts', 'Create an alert rule', {
    security: SESSION,
    body: S.CreateAlertInput,
    responses: { 201: json(S.AlertRule, 'Created'), 422: errors[422] },
  });
  route('get', '/alerts/{id}', 'Alerts', 'Alert rule with recent trigger history', {
    security: SESSION,
    params: idParam('alr'),
    responses: { 200: json(S.AlertRuleDetail), 404: errors[404] },
  });
  route('patch', '/alerts/{id}', 'Alerts', 'Edit, pause or resume a rule', {
    security: SESSION,
    params: idParam('alr'),
    body: S.UpdateAlertInput,
    responses: { 200: json(S.AlertRule), 404: errors[404] },
  });
  route('delete', '/alerts/{id}', 'Alerts', 'Delete a rule', {
    security: SESSION,
    params: idParam('alr'),
    responses: { 204: { description: 'Deleted' } },
  });
  route('post', '/alerts/{id}/evaluate', 'Alerts', 'Dry run: would it fire at the current price?', {
    security: SESSION,
    params: idParam('alr'),
    responses: { 200: json(S.Evaluation) },
  });

  // ---- Prices, usage, health
  route('get', '/prices/{symbol}', 'Prices', 'Latest price and 24 h history', {
    security: SESSION,
    params: z.object({ symbol: z.enum(S.SUPPORTED_SYMBOLS) }),
    query: z.object({ provider: z.enum(S.PRICE_PROVIDERS).optional() }),
    responses: { 200: json(S.PriceResponse) },
  });
  route('get', '/usage', 'Usage', 'Daily usage counters', {
    security: SESSION,
    query: z.object({ days: z.number().int().min(1).max(90).optional() }),
    responses: { 200: json(S.UsageResponse) },
  });
  route('get', '/health', 'Health', 'Liveness', {
    responses: { 200: { description: 'Process is up' } },
  });
  route('get', '/ready', 'Health', 'Readiness (DB reachable, migrations applied)', {
    responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } },
  });

  return new OpenApiGeneratorV31(r.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Alertly API',
      version: '1.0.0',
      description:
        'Reliable notification delivery by email, webhook and Telegram, plus price alerts.\n\n' +
        'Errors use one shape (problem+json). Lists use cursor pagination. Webhooks are signed: see the README.',
    },
    servers: [{ url: serverUrl }],
  });
}
