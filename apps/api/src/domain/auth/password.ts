import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { zxcvbnAsync, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

zxcvbnOptions.setOptions({
  dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
  graphs: zxcvbnCommon.adjacencyGraphs,
  translations: zxcvbnEn.translations,
});

const BCRYPT_COST = 12;
// Constant-time-ish dummy hash for unified latency on unknown users
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuv1234567890abcdefghijklmnopqrstuvwxyzZ';

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(plaintext, hash ?? DUMMY_HASH);
}

export type PasswordStrengthIssue =
  | 'too_short'
  | 'low_entropy'
  | 'too_few_classes'
  | 'contains_email'
  | 'pwned';

export type PasswordCheckResult = {
  ok: boolean;
  issues: PasswordStrengthIssue[];
  score: number;
};

export async function checkPasswordStrength(
  password: string,
  email?: string,
): Promise<PasswordCheckResult> {
  const issues: PasswordStrengthIssue[] = [];
  if (password.length < 8) issues.push('too_short');

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) issues.push('too_few_classes');

  if (email && password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) {
    issues.push('contains_email');
  }

  const result = await zxcvbnAsync(password, email ? [email] : undefined);
  if (result.score < 3) issues.push('low_entropy');

  if (await isPasswordPwned(password)) issues.push('pwned');

  return { ok: issues.length === 0, issues, score: result.score };
}

async function isPasswordPwned(password: string): Promise<boolean> {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0]!.trim() === suffix);
  } catch {
    return false;
  }
}
