export type SecondFactor = 'email' | 'totp' | 'passkey' | 'recovery';
/** 登录成功响应：携带令牌对与最新用户资料（user 形状由消费端定义） */
export type LoginResult =
  | { id: number; requiresTwoFactor?: false; accessToken: string; refreshToken: string; expiresIn: number; user: Record<string, unknown> }
  | { requiresTwoFactor: true; methods: SecondFactor[] };
export interface SecurityStatus {
  enabled: boolean;
  email: boolean;
  totp: boolean;
  passkeys: Array<{ id: string; name: string; createdAt: number }>;
  recoveryRemaining: number;
  emailAvailable: boolean;
  mailAvailable: boolean;
  totpAvailable: boolean;
  passkeysAvailable: boolean;
  reauthenticated: boolean;
  hasPassword: boolean;
}
export interface SecurityChallenge {
  methods: SecondFactor[];
  expiresAt: number;
  email: string | null;
  account: string;
  purpose: 'login' | 'reauth';
}
