'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type {
  AlertRule,
  AlertRuleDetail,
  ApiKey,
  ApiKeyCreated,
  Channel,
  ChannelWithSecret,
  CreateAlertInput,
  CreateChannelInput,
  CreateNotificationInput,
  Delivery,
  DeliveryStats,
  DeliveryWithAttempts,
  Evaluation,
  LoginInput,
  Notification,
  NotificationDetail,
  Page,
  PriceResponse,
  RegisterInput,
  UpdateAlertInput,
  UpdateChannelInput,
  UsageResponse,
  User,
} from '@alertly/shared';
import { apiFetch } from './api';

/**
 * One hook per API resource. TanStack Query caches responses by key, dedupes identical
 * requests, refetches in the background, and gives every screen loading/error states.
 * Mutations invalidate the keys they affect, so lists refresh after a change.
 */

const keys = {
  me: ['me'] as const,
  channels: ['channels'] as const,
  apiKeys: ['api-keys'] as const,
  notifications: (f: object) => ['notifications', f] as const,
  notification: (id: string) => ['notification', id] as const,
  deliveries: (f: object) => ['deliveries', f] as const,
  stats: ['delivery-stats'] as const,
  alerts: ['alerts'] as const,
  alert: (id: string) => ['alert', id] as const,
  price: (s: string) => ['price', s] as const,
  usage: (d: number) => ['usage', d] as const,
};

function useInvalidate() {
  const qc = useQueryClient();
  return (...ks: QueryKey[]) => Promise.all(ks.map((k) => qc.invalidateQueries({ queryKey: k })));
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- auth ----------
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: () => apiFetch<{ user: User }>('/auth/me'),
    retry: false,
  });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => apiFetch<{ user: User }>('/auth/login', { json: input }),
    onSuccess: (data) => qc.setQueryData(keys.me, data),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) =>
      apiFetch<{ user: User }>('/auth/register', { json: input }),
    onSuccess: (data) => qc.setQueryData(keys.me, data),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.clear(),
  });
}

// ---------- channels ----------
export const useChannels = () =>
  useQuery({ queryKey: keys.channels, queryFn: () => apiFetch<{ data: Channel[] }>('/channels') });

export function useCreateChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateChannelInput) =>
      apiFetch<ChannelWithSecret>('/channels', { json: input }),
    onSuccess: () => invalidate(keys.channels),
  });
}

export function useUpdateChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateChannelInput & { id: string }) =>
      apiFetch<Channel>(`/channels/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => invalidate(keys.channels),
  });
}

export function useDeleteChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(keys.channels),
  });
}

export const useTestChannel = () =>
  useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ notificationId: string }>(`/channels/${id}/test`, { method: 'POST' }),
  });

export const useRotateSecret = () =>
  useMutation({
    mutationFn: (id: string) =>
      apiFetch<ChannelWithSecret>(`/channels/${id}/rotate-secret`, { method: 'POST' }),
  });

// ---------- API keys ----------
export const useApiKeys = () =>
  useQuery({ queryKey: keys.apiKeys, queryFn: () => apiFetch<{ data: ApiKey[] }>('/api-keys') });

export function useCreateApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) => apiFetch<ApiKeyCreated>('/api-keys', { json: { name } }),
    onSuccess: () => invalidate(keys.apiKeys),
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(keys.apiKeys),
  });
}

// ---------- notifications ----------
/** Cursor pagination: each page carries `nextCursor`; "Load more" fetches the next one. */
export const useNotifications = (filters: { source?: string }) =>
  useInfiniteQuery({
    queryKey: keys.notifications(filters),
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Notification>>(
        `/notifications${qs({ ...filters, limit: 20, cursor: pageParam })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** Polls every 2 s while any delivery is still in flight, then stops by itself. */
export const useNotification = (id: string) =>
  useQuery({
    queryKey: keys.notification(id),
    queryFn: () => apiFetch<NotificationDetail>(`/notifications/${id}`),
    refetchInterval: (q) =>
      q.state.data?.deliveries.some((d) => ['pending', 'sending', 'retrying'].includes(d.status))
        ? 2000
        : false,
  });

export function useSendNotification() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: Partial<CreateNotificationInput> & { title: string }) =>
      apiFetch<Notification>('/notifications', {
        json: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }),
    onSuccess: () => invalidate(['notifications'], keys.stats),
  });
}

// ---------- deliveries ----------
export const useDeliveries = (filters: { status?: string }) =>
  useInfiniteQuery({
    queryKey: keys.deliveries(filters),
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Delivery>>(`/deliveries${qs({ ...filters, limit: 25, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });

export const useDeliveryStats = () =>
  useQuery({
    queryKey: keys.stats,
    queryFn: () => apiFetch<DeliveryStats>('/deliveries/stats?hours=24'),
    refetchInterval: 15_000,
  });

export function useRetryDelivery() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeliveryWithAttempts>(`/deliveries/${id}/retry`, { method: 'POST' }),
    onSuccess: () => invalidate(['deliveries'], ['notification'], keys.stats),
  });
}

// ---------- alerts ----------
export const useAlerts = () =>
  useQuery({
    queryKey: keys.alerts,
    queryFn: () => apiFetch<{ data: AlertRule[] }>('/alerts'),
    refetchInterval: 15_000,
  });

export const useAlert = (id: string) =>
  useQuery({
    queryKey: keys.alert(id),
    queryFn: () => apiFetch<AlertRuleDetail>(`/alerts/${id}`),
    refetchInterval: 15_000,
  });

export function useCreateAlert() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateAlertInput) => apiFetch<AlertRule>('/alerts', { json: input }),
    onSuccess: () => invalidate(keys.alerts),
  });
}

/**
 * Optimistic update for the pause/resume toggle: the switch flips instantly, and rolls back
 * if the server says no. Only used for safe, easily-reversed changes.
 */
export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAlertInput & { id: string }) =>
      apiFetch<AlertRule>(`/alerts/${id}`, { method: 'PATCH', json: input }),
    onMutate: async ({ id, isActive }) => {
      if (isActive === undefined) return undefined;
      await qc.cancelQueries({ queryKey: keys.alerts });
      const previous = qc.getQueryData<{ data: AlertRule[] }>(keys.alerts);
      qc.setQueryData<{ data: AlertRule[] }>(keys.alerts, (old) =>
        old ? { data: old.data.map((a) => (a.id === id ? { ...a, isActive } : a)) } : old,
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.alerts, ctx.previous);
    },
    onSettled: (_d, _e, { id }) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.alerts }),
        qc.invalidateQueries({ queryKey: keys.alert(id) }),
      ]),
  });
}

export function useDeleteAlert() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/alerts/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(keys.alerts),
  });
}

export const useDryRun = () =>
  useMutation({
    mutationFn: (id: string) => apiFetch<Evaluation>(`/alerts/${id}/evaluate`, { method: 'POST' }),
  });

// ---------- prices & usage ----------
export const usePrice = (symbol: string) =>
  useQuery({
    queryKey: keys.price(symbol),
    queryFn: () => apiFetch<PriceResponse>(`/prices/${symbol}`),
    refetchInterval: 30_000,
    retry: false,
  });

export const useUsage = (days = 30) =>
  useQuery({
    queryKey: keys.usage(days),
    queryFn: () => apiFetch<UsageResponse>(`/usage?days=${days}`),
  });
