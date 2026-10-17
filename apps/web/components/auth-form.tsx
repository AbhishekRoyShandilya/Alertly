'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginInput, RegisterInput } from '@alertly/shared';
import { errorMessage } from '@/lib/api';
import { useLogin, useRegister } from '@/lib/hooks';
import { Logo } from './app-shell';
import { Button, Card, ErrorNote, Field, Input } from './ui';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const login = useLogin();
  const registerUser = useRegister();
  const mutation = mode === 'login' ? login : registerUser;
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(mode === 'login' ? LoginInput : RegisterInput),
  });

  const onSubmit = (values: RegisterInput) =>
    mutation.mutate(values, { onSuccess: () => router.replace('/') });

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card>
          <h1 className="text-lg font-semibold">
            {mode === 'login' ? 'Log in' : 'Create your account'}
          </h1>
          <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-4" noValidate>
            {mode === 'register' && (
              <Field label="Name (optional)" htmlFor="name" error={errors.name?.message}>
                <Input id="name" autoComplete="name" {...register('name')} />
              </Field>
            )}
            <Field label="Email" htmlFor="email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" {...register('email')} />
            </Field>
            <Field
              label="Password"
              htmlFor="password"
              hint={mode === 'register' ? 'At least 10 characters' : undefined}
              error={errors.password?.message}
            >
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                {...register('password')}
              />
            </Field>
            {mutation.error && <ErrorNote error={new Error(errorMessage(mutation.error))} />}
            <Button type="submit" className="w-full" loading={mutation.isPending}>
              {mode === 'login' ? 'Log in' : 'Create account'}
            </Button>
          </form>
          {mode === 'login' && (
            <button
              type="button"
              className="mt-4 w-full text-center text-xs text-brand-600 hover:underline"
              onClick={() => {
                setValue('email', 'demo@alertly.dev');
                setValue('password', 'demo-password-123');
              }}
            >
              Fill in the read-only demo account
            </button>
          )}
        </Card>
        <p className="mt-6 text-center text-sm text-slate-500">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <Link href="/register" className="font-medium text-brand-600 hover:underline">
                Sign up
              </Link>
            </>
          ) : (
            <>
              Already registered?{' '}
              <Link href="/login" className="font-medium text-brand-600 hover:underline">
                Log in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
